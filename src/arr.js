var httpProxy = require('http-proxy'),
	url = require('url'),
	http = require('http');

var argv = require('optimist')
	.usage('Usage: $0')
	.options('m', {
		alias: 'mongo',
		description: 'Mongo DB connecton string',
		default: ''
	})
	.options('p', {
		alias: 'port',
		description: 'ARR listen port',
		default: 31415
	})
	.check(function (args) { return !args.help; })
	.argv;

var db;
var machinesCollection;
var appsCollection;
var machines;

console.log('Mongo: ' + argv.m);
console.log('Port:  ' + argv.p);

function onProxyError(context, status, error) {
	context.req.resume();
	context.res.writeHead(status);
	context.res.end(typeof error === 'string' ? error : JSON.stringify(error));
}

function routeToMachine(context) {
	console.log('Routing to ' + JSON.stringify(context.app.machines[context.machineIndex]));
	context.req.resume();
	context.proxy.proxyRequest(context.req, context.res, context.app.machines[context.machineIndex]);
	//context.proxy.proxyRequest(context.req, context.res, {host:'google.com', port:80});
}

function updateAppWithNewInstance(context) {
	appsCollection.update(
		{ _id: context.app._id }, 
		{ $push: { machines: context.app.newMachine }},
		function (err) {
			if (err) {
				onProxyError(context, 500, err);
			}
			else {
				context.app.machines.push(context.app.newMachine);
				routeToMachine(context);
			}
		});
}

function provisionMachine(context) {
	var machineToProvision = machines[Math.floor(machines.length * Math.random())];
	http.request({
		method: 'POST',
		hostname: machineToProvision.url.hostname,
		port: machineToProvision.url.port
	}, function (res) {
		var body = '';
		res.on('data', function (chunk) { body += chunk; }).on('end', function () {
			if (res.statusCode !== 201)
				onProxyError(context, 'Backend responded with HTTP ' + res.statusCode + ': ' + body);
			else {
				var newMachine;
				try {
					newMachine = JSON.parse(body); 
					if (!newMachine.host || !newMachine.port) {
						newMachine = undefined;
						throw "Invalid response";
					}
				}
				catch (e) {
					onProxyError(context, 500, 'Backend responded with invalid JSON: ' + body);	
				}

				if (newMachine) {
					context.app.newMachine = newMachine;
					updateAppWithNewInstance(context);
				}
			}
		})
		.on('error', function (err) {
			onProxyError(context, 500, err);
		});
	})
	.on('error', function (err) {
		onProxyError(context, 500, err);
	})
	.end(JSON.stringify(context.app));
}

function routeToApp(context) {
	context.machineIndex = Math.floor(Math.min(context.app.instances, context.app.machines.length + 1) * Math.random());
	if (context.machineIndex < context.app.machines.length)
		routeToMachine(context);
	else
		provisionMachine(context);
}

function loadApp(context) {
	var host = context.req.headers['host'].toLowerCase();
	appsCollection.findOne({ hosts: host }, function (err, result) {
		if (err || !result) {
			onProxyError(context, 404, err || 'Web application not found in registry');
		}
		else {
			context.app = result;
			if (!context.app.machines)
				context.app.machines = [];
			routeToApp(context);
		}
	})
}

function onRouteRequest(req, res, proxy) {
	req.pause();
	loadApp({ req: req, res: res, proxy: proxy});
}

function setupRouter() {
	httpProxy.createServer(onRouteRequest).listen(argv.p);
	console.log('HTTP router started and listening on port ' + argv.p);
	console.log('Ctrl-C to terminate');
}

function loadMachines() {
	machinesCollection.find().toArray(function (err, result) {
		if (err) throw err;
		console.log('Loaded list of web farm machines:');
		machines = result;
		machines.forEach(function (machine) { 
			machine.url = url.parse(machine.processManagerUrl);
			console.log('    ' + machine.processManagerUrl); 
		});
		setupRouter();
	})	
}

function loadMachinesCollection() {
	db.collection('machines', function (err, result) {
		if (err) throw err;
		console.log('Loaded machines collection');
		machinesCollection = result;
		loadMachines();
	})	
}

function loadAppsCollection() {
	db.collection('apps', function (err, result) {
		if (err) throw err;
		console.log('Loaded apps collection');
		appsCollection = result;
		loadMachinesCollection();
	})	
}

function connectDatabase() {
	require('mongodb').connect(argv.m, {}, function (err, result) {
		if (err) throw err;
		console.log('Connected to Mongo DB');
		db = result;
		loadAppsCollection();
	})
}

connectDatabase();

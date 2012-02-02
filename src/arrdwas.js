var httpProxy = require('http-proxy'),
	url = require('url'),
	http = require('http'),
	https = require('https'),
	spawn = require('child_process').spawn,
	net = require('net'),
	mongo = require('mongodb'),
	fs = require('fs');

var startPort, endPort, currentPort;
var processes = {};
var localIP;
var db;
var appsCollection;
var argv;
var key;
var cert;

function readConfiguration() {
	argv = require('optimist')
		.usage('Usage: $0')
		.options('m', {
			alias: 'mongo',
			description: 'Mongo DB connecton string',
			default: 'mongodb://localhost/arr'
		})
		.options('r', {
			alias: 'range',
			description: 'Managed TCP port range',
			default: '8000-9000'
		})
		.options('p', {
			alias: 'port',
			description: 'Unsecured listen port',
			default: 31415
		})
		.options('s', {
			alias: 'sslport',
			description: 'SSL listen port',
			default: 31416
		})
		.options('c', {
			alias: 'cert',
			description: 'Non-SNI (wildcard) server certificate for SSL',
			default: 'certs/wildcard-janczuk-cert.pem'
		})
		.options('k', {
			alias: 'key',
			description: 'Private key for SSL',
			default: 'certs/wildcard-janczuk-key.pem'
		})
		.check(function (args) { return !args.help; })
		.check(function (args) { return args.p != args.s; })
		.check(function (args) { 
			var index = args.r.indexOf('-');
			if (index < 1 || index >= (args.r.length - 1))
				return false;
				
			currentPort = startPort = parseInt(args.r.substring(0, index));
			endPort = parseInt(args.r.substring(index + 1));
			if (!startPort || !endPort)
				return false; 
		})
		.check(function (args) {
			cert = fs.readFileSync(args.c);
			key = fs.readFileSync(args.k);
			return true;
		})
		.argv;

	var ifaces=require('os').networkInterfaces();
	for (var dev in ifaces) {
		for (var i in ifaces[dev]) {
			var address = ifaces[dev][i];
			if (address.family === 'IPv4' && address.internal === false) {
				localIP = address.address;
				break;
			}
		}

		if (localIP)
			break;
	}

	if (!localIP) 
		throw "Unable to determine the IPv4 address of a local network interface.";		
}

function onProxyError(context, status, error) {
	if (context.socket) {
		context.socket.end();
	}
	else {
		context.req.resume();
		context.res.writeHead(status);
		context.res.end(typeof error === 'string' ? error : JSON.stringify(error));
	}
}

function routeToMachine(context) {
	// TODO: kick off the backend from the pool if down
	var machineName = context.backend.host === localIP ? 'localhost' : context.backend.host;
	var requestType = context.socket ? 'upgrade' : 'regular';
	console.log('Routing ' + requestType + ' request to ' + machineName + ':' + context.backend.port);
	if (context.socket) {
		context.socket.resume();
		context.proxy.proxyWebSocketRequest(context.req, context.socket, context.head, context.backend);	
	}
	else {
		context.req.resume();
		context.proxy.proxyRequest(context.req, context.res, context.backend);
	}
}

function updateAppWithNewInstance(context) {
	appsCollection.update(
		{ _id: context.app._id }, 
		{ $push: { machines: context.backend }},
		function (err) {
			if (err) 
				onProxyError(context, 500, err);
			else 
				routeToMachine(context);
		});
}

function getNextPort() {
	// TODO ensure noone is already listening on the port
	var sentinel = currentPort;
	var result;
	do {
		if (!processes[currentPort]) {
			result = currentPort;
			currentPort++;
			break;
		}

		currentPort++;
		if (currentPort > endPort)
			currentPort = startPort;
	} while (currentPort != sentinel);

	return result;
}

function getEnv(port) {
	var env = {};
	for (var i in process.env) {
		env[i] = process.env[i];
	}

	env['PORT'] = port;

	return env;
}

function waitForServer(context, port, attemptsLeft, delay) {
	var client = net.connect(port, function () {
		client.destroy();
		context.backend = { host: localIP, port: port };
		updateAppWithNewInstance(context);
	});

	client.on('error', function() {
		client.destroy();
		if (attemptsLeft === 0)
			onProxyError(context, 500, 'The application process did not establish a listener in a timely manner.');
		else 
			setTimeout(function () {
				waitForServer(context, port, attemptsLeft - 1, delay * 1.5);				
			}, delay);
	});
}

function createProcess(context) {
	var port = getNextPort();
	if (!port) {
		onProxyError(context, 500, 'No ports remain available to initiate application ' + context.app.command);
	}
	else {
		var env = getEnv(port);
		console.log('Creating new process: ' + JSON.stringify(context.app.process));
		var process = spawn(context.app.process.executable, context.app.process.args || [], { env: env });
		if (!process || (typeof process.exitCode === 'number' && process.exitCode !== 0)) {
			console.log(process.exitCode);
			console.log('Unable to start process: ' + context.app.command);
			onProxyError(context, 500, 'Unable to start process \'' + context.app.command + '\'');
		}
		else {
			processes[port] = process;
			process.stdout.on('data', function(data) { console.log('PID ' + process.pid + ':' + data); });
			process.stderr.on('data', function(data) { console.log('PID ' + process.pid + ':' + data); });
			process.on('exit', function (code, signal) {
				delete processes[port];
				console.log('Child process exited. Port: ' + port + ', PID: ' + process.pid + ', code: ' + code + ', signal: ' + signal);
				// TODO unregister the machine from the app
			});
			waitForServer(context, port, 3, 1000);
		}
	}
}

function routeToApp(context) {
	// Routing logic:
	// 1. If app instance is running on localhost, route to it
	// 2. Else, if max instances of the app have already been provisioned, pick one at random and route to it
	// 3. Else, provision an new instance on localhost and route to it

	for (var i in context.app.machines) {
		if (context.app.machines[i].host === localIP) {
			context.backend = context.app.machines[i];
			break;
		}
	}

	if (!context.backend && context.app.instances === context.app.machines.length) {
		context.backend = context.app.machines[Math.floor(context.app.instances * Math.random())];
	}

	if (context.backend)
		routeToMachine(context);
	else
		createProcess(context);
}

function loadApp(context) {
	var host = context.req.headers['host'].toLowerCase();
	appsCollection.findOne({ 'hosts.host' : host }, function (err, result) {
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

function onRouteUpgradeRequest(req, socket, head, proxy) {
	socket.pause();
	loadApp({ req: req, socket: socket, head: head, proxy: proxy});
}

function setupRouter() {
	var server = httpProxy.createServer(onRouteRequest);
	server.on('upgrade', function (req, res, head) { onRouteUpgradeRequest(req, res, head, server.proxy); });
	server.listen(argv.p);

	var options = { https: { cert: cert, key: key } };
	var secureServer = httpProxy.createServer(options, onRouteRequest);
	secureServer.on('upgrade', function (req, res, head) { onRouteUpgradeRequest(req, res, head, secureServer.proxy); });
	secureServer.listen(argv.s);

	console.log('ARRDWAS started');
	console.log('Ctrl-C to terminate');
}

function loadAppsCollection() {
	db.collection('apps', function (err, result) {
		if (err) throw err;
		console.log('Loaded apps collection');
		appsCollection = result;
		setupRouter();
	})	
}

function connectDatabase() {
	mongo.connect(argv.m, {}, function (err, result) {
		if (err) throw err;
		console.log('Connected to Mongo DB');
		db = result;
		loadAppsCollection();
	})
}

readConfiguration();

console.log('Managed TCP port range: ' + startPort + '-' + endPort);
console.log('Mongo DB: ' + argv.m);
console.log('Unsecured listen address: ' + localIP + ':' + argv.p);
console.log('SSL listen address: ' + localIP + ':' + argv.s);
console.log('Certificate: ' + argv.c);
console.log('Private key: '+ argv.k);

connectDatabase();

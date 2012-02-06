var httpProxy = require('http-proxy'),
	http = require('http'),
	https = require('https'),
	spawn = require('child_process').spawn,
	net = require('net'),
	mongo = require('mongodb'),
	fs = require('fs');

var startPort, endPort, currentPort;
var processes = {};
var localIP, db, appsCollection, argv, key, cert, sniApps;

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
		if ('HEAD' !== context.req.method)
			context.res.end(typeof error === 'string' ? error : JSON.stringify(error));
		else
			context.res.end();
	}
}

function getDestinationDescription(context) {
	var machineName = context.backend.host === localIP ? 'localhost' : context.backend.host;
	var requestType = (context.socket ? 'WS' : 'HTTP') + (context.proxy.secure ? 'S' : '');
	return requestType + ' request to ' + machineName + ':' + context.backend.port;	
}

function routeToMachine(context) {
	console.log('Routing ' + getDestinationDescription(context));
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
	appsCollection.update({ _id: context.app._id }, { $push: { machines: context.backend }},
		function (err) {
			err ? onProxyError(context, 500, err) : routeToMachine(context);
		});
}

function getNextPort() {
	// TODO ensure noone is already listening on the port
	var sentinel = currentPort;
	var result;
	do {
		if (!processes[currentPort]) {
			result = currentPort++;
			break;
		}

		currentPort++;
		currentPort %= (endPort + 1);
	} while (currentPort != sentinel);

	return result;
}

function getEnv(port) {
	var env = {};
	for (var i in process.env)
		env[i] = process.env[i];
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
		if (attemptsLeft === 0) {
			onProxyError(context, 500, 'The application process did not establish a listener in a timely manner.');
			console.log('Terminating unresponsive application process ' + context.process.pid);
			delete processes[context.process.port];
			try { process.kill(context.process.pid); }
			catch (e) {}
		} else 
			setTimeout(function () {
				waitForServer(context, port, attemptsLeft - 1, delay * 1.5);				
			}, delay);
	});
}

function createProcess(context) {
	var port = getNextPort();
	if (!port) {
		onProxyError(context, 500, 'No ports remain available to initiate application ' + JSON.stringify(context.app.process));
	}
	else {
		var env = getEnv(port);
		console.log('Creating new process: ' + JSON.stringify(context.app.process));
		try { context.process = spawn(context.app.process.executable, context.app.process.args || [], { env: env }); }
		catch (e) {};
		if (!context.process || (typeof context.process.exitCode === 'number' && context.process.exitCode !== 0)) {
			console.log('Unable to start process: ' + JSON.stringify(context.app.process));
			onProxyError(context, 500, 'Unable to start process: ' + JSON.stringify(context.app.process));
		}
		else {
			processes[port] = context.process;
			context.process.port = port;
			var logger = function(data) { console.log('PID ' + context.process.pid + ':' + data); };
			context.process.stdout.on('data', logger);
			context.process.stderr.on('data', logger);
			context.process.on('exit', function (code, signal) {
				delete processes[port];
				console.log('Child process exited. Port: ' + port + ', PID: ' + context.process.pid + ', code: ' + code + ', signal: ' + signal);

				// remove registration of the instance of the application that just exited

				appsCollection.update({ _id: context.app._id }, { $pull: { machines: { host: localIP, port: port }}}, 
					function (err) {
						if (err)
							console.log('Error removing registration of application ' + context.host + ' on ' + localIP + ':' + port + ': ' + err);
						else
							console.log('Removed registration of application ' + context.host + ' on ' + localIP + ':' + port);
					});
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

	if (!context.backend && context.app.instances === context.app.machines.length) 
		context.backend = context.app.machines[Math.floor(context.app.instances * Math.random())];

	if (context.backend)
		routeToMachine(context);
	else
		createProcess(context);
}

function ensureSecurityConstraints(context) {
	var host;
	for (var i in context.app.hosts) {
		if (context.app.hosts[i].host === context.host) {
			host = context.app.hosts[i];
			break;
		}
	}

	if (!host || (host.ssl === 'none' && context.proxy.secure) || (host.ssl === 'require' && !context.proxy.secure)) 
		onProxyError(context, 404, "Request security does not match security configuration of the application");
	else 
		routeToApp(context);
}

function loadApp(context) {
	context.host = context.req.headers['host'].toLowerCase();
	context.req.context = context;
	appsCollection.findOne({ 'hosts.host' : context.host }, function (err, result) {
		if (err || !result) {
			onProxyError(context, 404, err || 'Web application not found in registry');
		}
		else {
			context.app = result;
			if (!context.app.machines)
				context.app.machines = [];
			ensureSecurityConstraints(context);
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

function onProxyingError(err, req, res) {
	console.log('Error routing ' + getDestinationDescription(req.context));

	// remove failing backend from application matadata and return error to client

	appsCollection.update({ _id: req.context.app._id }, { $pull: { machines: { host: req.context.backend.host }}}, 
		function (err1) {
			onProxyError(req.context, 500, 'An error occurred when routing: ' + JSON.stringify(err1 || err ||  'unknown'));
		});
}

function setupRouter() {

	// setup HTTP/WS proxy

	var server = httpProxy.createServer(onRouteRequest);
	server.proxy.on('proxyError', onProxyingError);
	server.on('upgrade', function (req, res, head) { onRouteUpgradeRequest(req, res, head, server.proxy); });
	server.listen(argv.p);

	// setup HTTPS/WSS proxy along with SNI information for individual apps

	var options = { https: { cert: cert, key: key } };
	var secureServer = httpProxy.createServer(options, onRouteRequest);
	secureServer.proxy.secure = true;
	secureServer.proxy.on('proxyError', onProxyingError);
	secureServer.on('upgrade', function (req, res, head) { onRouteUpgradeRequest(req, res, head, secureServer.proxy); });
	// TODO design way to update SNI information when metadata changes (use SNI callback?)
	sniApps.forEach(function (app) {
		app.hosts.forEach(function (host) {
			if (host.host && host.ssl && host.ssl !== 'none' && host.key && host.cert) {
				console.log('Configuring SNI for hostname ' + host.host);
				secureServer.addContext(host.host, {
					cert: fs.readFileSync(host.cert),
					key: fs.readFileSync(host.key)
				});
			}
		});
	});
	secureServer.listen(argv.s);

	console.log('ARRDWAS started');
	console.log('Ctrl-C to terminate');
}

function loadSNIConfiguration() {
	appsCollection.find({ $or: [{ 'hosts.ssl': 'require' }, { 'hosts.ssl': 'allow' }]}).toArray(function (err, result) {
		if (err) throw err;
		console.log('Loaded SNI configuration');
		sniApps = result;
		setupRouter();
	});
}

function loadAppsCollection() {
	db.collection('apps', function (err, result) {
		if (err) throw err;
		console.log('Loaded apps collection');
		appsCollection = result;
		loadSNIConfiguration();
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

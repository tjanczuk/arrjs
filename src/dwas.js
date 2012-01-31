var url = require('url'),
	http = require('http'),
	spawn = require('child_process').spawn,
	net = require('net');

var startPort, endPort, currentPort;
var processes = {};
var localIP;

var argv = require('optimist')
	.usage('Usage: $0')
	.options('r', {
		alias: 'range',
		description: 'Managed TCP port range',
		default: '8000-9000'
	})
	.options('p', {
		alias: 'port',
		description: 'Process manager listen port',
		default: 31415
	})
	.check(function (args) { return !args.help; })
	.check(function (args) { 
		var index = args.r.indexOf('-');
		if (index < 1 || index >= (args.r.length - 1))
			return false;
			
		currentPort = startPort = parseInt(args.r.substring(0, index));
		endPort = parseInt(args.r.substring(index + 1));
		if (!startPort || !endPort)
			return false; 
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
	throw "Unable to determine the IP address of a network interface."
else
	console.log('Local IP address: ' + localIP)

console.log('Managed TCP port range: ' + startPort + '-' + endPort);
console.log('Process manager listen port:  ' + argv.p);

function onError(res, status, error) {
	res.writeHead(status);
	if (error)
		res.end(typeof error === 'string' ? error : JSON.stringify(error));
	else 
		res.end();
}

function getNextPort() {
	var sentinel = currentPort;
	var result;
	do {
		if (!processes[currentPort]) {
			result = currentPort;
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

function sendResponse(res, port) {
	res.writeHead(201);
	res.end(JSON.stringify({ host: localIP, port: port }));
}

function waitForServer(res, port, attemptsLeft, delay) {
	var client = net.connect(port, function () {
		client.destroy();
		sendResponse(res, port);
	});

	client.on('error', function() {
		client.destroy();
		if (attemptsLeft === 0)
			onError(res, 500, 'The server process did not establish a listener in a timely manner.');
		else 
			setTimeout(function () {
				waitForServer(res, port, attemptsLeft - 1, delay * 1.5);				
			}, delay);
	});
}

function createProcess(res, app) {
	var port = getNextPort();
	if (!port) {
		onError(res, 500, 'No ports remain available to initiate application ' + app.command);
	}
	else {
		var env = getEnv(port);
		console.log('Creating new process: ' + JSON.stringify(app.process));
		var process = spawn(app.process.executable, app.process.args || [], { env: env });
		if (!process || (typeof process.exitCode === 'number' && process.exitCode !== 0)) {
			console.log(process.exitCode);
			console.log('Unable to start process: ' + app.command);
			onError(res, 500, 'Unable to start process \'' + app.command + '\'');
		}
		else {
			processes[port] = process;
			process.on('exit', function (code, signal) {
				delete processes[port];
				console.log('Child process exited. Port: ' + port + ', PID: ' + process.pid + ', code: ' + code + ', signal: ' + signal)	
			});
			waitForServer(res, port, 3, 1000);
		}
	}
}

http.createServer(function (req, res) {
	if (req.method === 'POST' && req.url === '/') {
		var body = '';
		req
			.on('data', function (chunk) { body += chunk; })
			.on('error', function (error) { onError(res, 500, error) })
			.on('end', function () {
				var app;
				try {
					app = JSON.parse(body);
					if (!app.process || !app.process.executable) {
						app = undefined;
						throw 'No application command line specified';
					}
				}
				catch (e) {
					onError(res, 400, e);
				}

				if (app)
					createProcess(res, app);
			});
	}
	else {
		onError(res, 400, 'HTTP endpoint not implemented: ' + req.method + ' ' + req.url);
	}
}).listen(argv.p);

console.log('Process manager started. Ctrl-C to terminate.');

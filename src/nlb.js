var config = require('./nlb.json');
var net = require('net');

var currentBackend = 0;

console.log('NLB: TCP level round robin load balancer')
console.log('Listen port: ' + config.port);
console.log('Backends:');
config.backends.forEach(function (backend) { console.log('    ' + backend.host + ':' + backend.port)});

function routeToBackend(connection) {
	var backend = config.backends[currentBackend];
	currentBackend++;
	currentBackend %= config.backends.length;
	var client = net.connect(backend.port, backend.host, function () {
		console.log('Routing new connection to ' + backend.host + ':' + backend.port);
		connection.resume();
		connection.pipe(client).pipe(connection);
	}).on('error', function (err) {
		console.log('Error routing new connection to ' + backend.host + ':' + backend.port + ': ' + err);
		connection.end();
	});
}

net.createServer(function (connection) {
	connection.pause();
	routeToBackend(connection);
}).listen(config.port, function() {
	console.log('NLB is bound to the listen port');
	console.log('Ctrl-C to terminate');
})

var config = require('./nlb.json');
var net = require('net');

console.log('NLB: TCP level round robin load balancer')
console.log('Ctrl-C to terminate');

function routeToBackend(connection, route) {
	var backend = route.backends[currentBackend];
	route.currentBackend++;
	route.currentBackend %= route.backends.length;
	var client = net.connect(backend.port, backend.host, function () {
		console.log('Routing new connection on port ' + route.port + ' to ' + backend.host + ':' + backend.port);
		connection.resume();
		connection.pipe(client).pipe(connection);
	}).on('error', function (err) {
		console.log('Error routing new connection on port ' + route.port + ' to ' + backend.host + ':' + backend.port + ': ' + err);
		connection.end();
	});
}

config.forEach(function (route) {
	route.currentBackend = 0;
	net.createServer(function (connection) {
		connection.pause();
		routeToBackend(connection, route);
	}).listen(route.port, function() {
		console.log('NLB is bound to the listen port ' + route.port);
		console.log('  Backends:');
		route.backends.forEach(function (backend) { console.log('    ' + backend.host + ':' + backend.port)});
	})	
});

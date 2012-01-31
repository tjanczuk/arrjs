var http = require('http');

var port = process.env.PORT || 8888;

http.createServer(function (req, res) {
	res.writeHead(200);
	res.end('Hello from app2 running on port ' + port + ' with PID ' + process.pid + '\n');
}).listen(port);
#HTTP and WebSocket application routing
===

With ARR.JS you can expose several HTTP or WebSocket applications over a single TCP port. This is useful for better utilization of servers, including shared hosting. 

- Host N applications on M servers, each application in K(N) instances, 1 <= K(N) <= M.
- Routing based on the Host HTTP request header.
- HTTP and HTTPS.
- WebSockets and secure WebSockets.
- Message-based process activation.
- Process monitoring and crash recovery. 
- Arbitrary application technology with its own HTTP stack, including node.js.
- Works on Windows, MacOS, and *nix. 
- Built with node.js and MongoDB. 

## Prerequisities

- Windows, MacOS, *nix (tested on Windows 7 & 2008 Server, MacOS Lion, Ubuntu 11.10)
- [node.js v0.7.0 or greater](http://nodejs.org/dist/). MacOS and *nix may use earlier versions.
- [MongoDB](http://www.mongodb.org/downloads). The database is used to store application metadata and must be accessible from all backends. 

## Getting started

Instructions below are for setting up a single machine deployment (e.g. development environemnt) on a MacOS. Other OSes are conceptually similar. 

Start unsecure MongoDB server on localhost:

```
mongod
```

Import application metadata for the three sample applications:

```
mongoimport -d arr -c apps src/apps.json
```

Configure your HOSTS file (/etc/hosts on MacOS and *nix, %systemroot%\system32\drivers\etc\hosts on Windows) to resolve domain names used by the sample applications to localhost by adding the following lines:

```
127.0.0.1 app1.janczuk.org
127.0.0.1 app1.tangyorange.com
127.0.0.1 app2.janczuk.org
127.0.0.1 app2.tangyorange.com
127.0.0.1 ws1.janczuk.org
127.0.0.1 ws1.tangyorange.com
```

Start the ARR.JS router to listen for unsecured traffic on port 80 and SSL traffic on port 443 (these ports cannot not be used by other processes on the box)

```
cd src
sudo node arrdwas.js --mongo=mongodb://localhost/arr -p 80 -s 443
```

Issue a few requests to test the system:

```
curl http://app1.tangyorange.com
curl https://app1.janczuk.org -k
curl http://app2.janczuk.org
curl https://app2.janczuk.org -k
```

In your favorite modern browser navigate to ```http://ws1.janczuk.org```. You should see Dante's Divine Comedy streamed downed to you over a WebSocket connection, a stanza every 2 seconds. When connecting over ```https://ws1.janczuk.org``` you will first see a security warning because the certificate exposed by the application is not trusted (it is self-signed). 

## Deployments on a server farm

### Database

The MongoDB dabatase holds application metadata and must be accessible from all servers in the farm. You can use your own instance or get started with a free instance
provided by [MongoHQ](https://mongohq.com/home). Bottom line is you need a MongoDB connection URL to provide to all instances of arrdwas.js you will run
on the backends.

The application metadata is stored in a single MongoDB collection called ```apps```. Each document in this collection has the following structure:

```
{
  process: {
    executable: "node",                 // specify the executable name here, including path if needed
    args: [                             // specify whatever command line arguments must be passed to the executable
      "apps/app1/server.js"
    ]
  },
  hosts: [
    { 
      host: "app1.janczuk.org",
      ssl: "allowed",                       // you must say "allowed", "required", or "none" (for unsecure access only)
      cert: "certs/app1-janczuk-cert.pem",  // optional file with X.509 certificate associated with this host name
      key: "certs/app1-key.pem"             // optional file with the private key for the X.509 certificate
    },
    // ... you can specify multiple host names that can be used to access this application
  ],
  instances: 2,                             // maximum number of instances of this application to create
  machines: [                               // this is the array of machines the application is currently running on
  ]                                         // and it must be set to empty initially
}
```


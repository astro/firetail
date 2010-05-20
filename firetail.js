var http = require('http');
var sys = require('sys');
var xmpp = require("xmpp");
var base64 = require("base64");


var server = "superfeedr.com";
var sessions = {};

function Session(account) {
    var user = account[0], pass = account[1];

    /* Connection management */
    var readyCallbacks = {};
    this.onReady = function(id, cb) { readyCallbacks[id] = cb; };
    this.onEnd = function(id, todo) { };
    this.ready = function(status) {
	sys.puts(account + " " + status);
	for(var id in readyCallbacks)
	    readyCallbacks[id](status);
	readyCallbacks = {};
	/* Future requests can trigger ready immediately */
	this.onReady = function(id, cb) {
	    cb(status);
	};

	if (status != 'ok')
	{
	    /* Game over for this session */
	    sessions[account] = null;
	}
    };

    this.conn = new xmpp.Connection("xmpp.superfeedr.com", 5222);
    /*this.conn.log = function(level, message) {
	sys.puts("[" + level + "] " + message);
    };*/
    var session = this;
    sys.puts("Connect for "+account);
    this.conn.connect(user, server, pass,
		      function(status, condition) {
			  if (status == xmpp.Status.CONNECTED)
			      session.ready('ok');
			  else if (status == xmpp.Status.AUTHFAIL)
			      session.ready('auth');
			  else if (status == xmpp.Status.CONNFAIL ||
				   status == xmpp.Status.DISCONNECTED)
		              session.ready('error');
		      });

    /* Notification management */
    var notifyCallbacks = {};
    this.onNotification = function(id, cb) { notifyCallbacks[id] = cb; };
    this.conn.addHandler(function(msg) {
	sys.puts("notifyCallbacks: "+Object.keys(notifyCallbacks));
	for(var id in notifyCallbacks) {
	    sys.puts("notify callback for "+id);
	    notifyCallbacks[id](msg);
	}
    });

    /* Individual un-using, with shutdown */
    this.unref = function(id) {
	delete readyCallbacks[id];
	delete notifyCallbacks[id];

	/* Are callbacks still registered? */
	for(var id in readyCallbacks)
	    return;
	for(var id in notifyCallbacks)
	    return;
	/* No: */
	sys.puts("Shutdown for "+account);
	sessions[account] = null;
	this.conn.socket.end();
    };
}

function withSession(account, reqId, cb) {
    var session = sessions[account];
    if (!session)
	sessions[account] = session = new Session(account);
    sys.puts("session: " + session);
    session.onReady(reqId,
		    function(event) {
			sys.puts("event " + event);
			cb(event, session);
		    });
    return session;
}

/* req:: HTTP.ServerRequest
   result:: null or [String, String]
*/
function reqAuth(req) {
    var auth = req.headers['authorization'];
    if (auth)
    {
	var m = /^Basic (\S+)/.exec(auth);
	if (m[1])
	{
	    var up = /^(.+?):(.+)/.exec(base64.decode(m[1]));
	    var user = up[1], pass = up[2];
	    return [user, pass];
	}
	else
	    return null;
    }
    else
	return null;
}

var nextReqId = 0;

http.createServer(function(req, res) {
    try {
	var reqId = nextReqId;
	nextReqId++;

	sys.puts(req.method + " " + req.url);

	if (req.method == "GET" &&
	    req.url == "/pubsub.xml")
	{
	    var account = reqAuth(req);
	    if (account)
	    {
		var session = withSession(account, reqId,
					  function(event, session) {
					      sys.puts(reqId + " with: " + event);
					      if (event == 'ok') {
						  res.writeHead(200, {'Content-type': 'application/atom+xml'});
						  res.flush();
						  res._hasBody = true;
						  session.onNotification(reqId,
									 function(msg) {
									     sys.puts("writing to " + res);
									     res.write(msg.toString()+"\r\n");
									     res.flush();
									 });
						  session.onEnd(reqId, res.end);
					      }
					      else if (event == 'auth') {
						  res.writeHead(401, {});
						  res.end();
					      }
					      else {
						  res.writeHead(501, {});
						  res.end();
					      }
					  });
		req.socket.addListener('end',
				       function() {
					   sys.puts(reqId+" req end");
					   session.unref(reqId);
				       });
		req.socket.addListener('error',
				       function(e) {
					   sys.puts(reqId+" req socket error: "+e);
					   session.unref(reqId);
				       });
	    }
	    else {
		res.writeHead(401, {});
		res.end();
	    }
	}
	else {
	    res.writeHead(404, {});
	    res.end();
	}
    } catch (e) {
	sys.puts(e.name+": "+e.message+" in "+e.fileName+":"+e.lineNumber);
    }
}).listen(8888);


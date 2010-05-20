var http = require('http');
var sys = require('sys');
var xmpp = require("xmpp");
var base64 = require("base64");


var server = "superfeedr.com";
var sessions = {};

var defaultXmlns = { '': 'http://www.w3.org/2005/Atom',
		     geo: 'http://www.georss.org/georss',
		     as: 'http://activitystrea.ms/spec/1.0/',
		     sf: 'http://superfeedr.com/xmpp-pubsub-ext'
		   };


xmpp.StanzaBuilder.prototype.getChildren = function(name) {
    var children = [];
    this.tags.forEach(function(tag) {
	if (tag.name == name)
	    children.push(tag);
    });
    return children;
};
xmpp.StanzaBuilder.prototype.stripXmlns = function(parentXmlns) {
    sys.puts("stripXmlns for " + this.name + ": " + JSON.stringify(parentXmlns));
    for(var prefix in parentXmlns) {
	var xmlnsAttr;
	if (prefix == "")
	    xmlnsAttr = "xmlns";
	else
	    xmlnsAttr = "xmlns:" + prefix;

	/* Remove superfluous xmlns */
	if (this.attr[xmlnsAttr] == parentXmlns[prefix])
	    delete this.attr[xmlnsAttr];

	/* Learn all xmlns */
	currentXmlns = Object.create(parentXmlns);
	for(var attr in this.attr) {
	    var m;
	    if (attr == "xmlns")
		currentXmlns[''] = this.attr[attr];
	    else if (m = /^xmlns:(.+)/.exec(attr)) {
		var prefix = m[1];
		currentXmlns[prefix] = this.attr[attr];
	    }
	}
	/* Apply to children */
	this.tags = this.tags.map(function(tag) {
	    if (tag.stripXmlns)
		tag.stripXmlns(currentXmlns);
	    return tag;
	});
    }
};

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
    this.conn.addHandler(function(msgEl) {
	msgEl.getChildren("event").forEach(function(eventEl) {
	    eventEl.getChildren("items").forEach(function(itemsEl) {
		var node = itemsEl.getAttribute("node");
		if (node)
		{
		    var entries = [];
		    itemsEl.getChildren("item").forEach(function(itemEl) {
			itemEl.getChildren("entry").forEach(function(entryEl) {
			    entries.push(entryEl);
			});
		    });
		    if (entries.length > 0)
			for(var id in notifyCallbacks) {
			    notifyCallbacks[id](node, entries);
			}
		}
	    });
	});
    }, null, "message");

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

/* Controllers */
function handleWithSession(req, res, account, reqId, cb) {
    var session = withSession(account, reqId,
			      function(event, session) {
				  sys.puts(reqId + " with: " + event);
				  if (event == 'ok') {
				      session.onEnd(reqId, res.end);
				      cb(res, reqId, session);
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

function setupStreamATOM(res, reqId, session) {
    res.writeHead(200, {'Content-type': 'application/atom+xml'});
    res.write("<feed");
    for(var prefix in defaultXmlns) {
	res.write(" xmlns");
	if (prefix != '')
	    res.write(":"+prefix);
	res.write("=\""+defaultXmlns[prefix]+"\"");
    }
    res.write(">");
    res.flush();
    res._hasBody = true;
    session.onNotification(reqId,
			   function(node, entries) {
			       sys.puts("writing to " + res + " for " + node);
			       entries.forEach(function(entry) {
				   entry.stripXmlns(defaultXmlns);
				   res.write(entry.toString()+"\r\n");
			       });
			       res.flush();
			   });
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

	var account = reqAuth(req);
	if (account) {
	    if (req.method == "GET" && req.url == "/pubsub.xml") {
		handleWithSession(req, res, account, reqId, setupStreamATOM);
	    } else {
		res.writeHead(404, {});
		res.end();
	    }
	}
	else {
	    res.writeHead(401, {});
	    res.end();
	}
    } catch (e) {
	sys.puts(e.name+": "+e.message+" in "+e.fileName+":"+e.lineNumber);
    }
}).listen(8888);


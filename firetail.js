var http = require('http');
var sys = require('sys');
var xmpp = require("xmpp");
var base64 = require("base64");


var SERVER = "xmpp.superfeedr.com";
var PORT = 5222;
var DOMAIN = "superfeedr.com";
var PUBSUB_SERVICE = "firehoser.superfeedr.com";
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
xmpp.StanzaBuilder.prototype.getChildText = function(name) {
    var text = null;
    this.tags.forEach(function(tag) {
	if (!text && tag.name == name)
	{
	    text = tag.getText();
	}
    });
    return text;
};
xmpp.StanzaBuilder.prototype.stripXmlns = function(parentXmlns) {
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

    this.conn = new xmpp.Connection(SERVER, PORT);
    /*this.conn.log = function(level, message) {
	sys.puts("[" + level + "] " + message);
    };*/
    var session = this;
    sys.puts("Connect for "+account);
    this.conn.connect(user, DOMAIN, pass,
		      function(status, condition) {
			  if (status == xmpp.Status.CONNECTED) {
			      session.ready('ok');
			      this.send(xmpp.presence(null));
			  }
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
	return true;
    }, null, "message", null, null, PUBSUB_SERVICE);

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
				   entry.c("link", { rel: "via",
						     href: node });
				   entry.stripXmlns(defaultXmlns);
				   res.write(entry.toString()+"\r\n");
			       });
			       res.flush();
			   });
}

function xmlToAttr(el, name, json) {
    var text = el.getChildText(name);
    if (text)
	json[name] = text;
}
function xmlAttrToAttr(el, name, json) {
    var text = el.getAttribute(name);
    if (text)
	json[name] = text;
}
function xmlToLink(linkEl) {
    var json = {};
    xmlAttrToAttr(linkEl, "rel", json);
    xmlAttrToAttr(linkEl, "href", json);
    xmlAttrToAttr(linkEl, "type", json);
    xmlAttrToAttr(linkEl, "title", json);
    return json;
}
function xmlToAuthor(authorEl) {
    var json = {};
    xmlToAttr(authorEl, "name", json);
    xmlToAttr(authorEl, "uri", json);
    xmlToAttr(authorEl, "email", json);
    return json;
}
function setupStreamJSON(res, reqId, session) {
    res.writeHead(200, {'Content-type': 'application/json'});
    res.flush();
    res._hasBody = true;
    session.onNotification(reqId,
			   function(node, entries) {
			       sys.puts("writing to " + res + " for " + node);
			       entries.forEach(function(entry) {
				   var json = {};
				   xmlToAttr(entry, "id", json);
				   xmlToAttr(entry, "title", json);
				   xmlToAttr(entry, "published", json);
				   xmlToAttr(entry, "content", json);
				   xmlToAttr(entry, "summary", json);
				   json['links'] = entry.getChildren("link").map(xmlToLink);
				   json['authors'] = entry.getChildren("author").map(xmlToAuthor);
				   var line = JSON.stringify(json) + "\n";
				   res.write(line.length + "\n" + line);
			       });
			       res.flush();
			   });
}

function setupRequest(iqGenerator, doneFun) {
    return function(req, reqId, session) {
	var id = reqId.toString();
	stanza = iqGenerator(session);
	sys.puts("generated: "+stanza.toString());
	stanza.attr['to'] = PUBSUB_SERVICE;
	stanza.attr['id'] = id;
	sys.puts("augmented: "+stanza.toString());
	session.conn.send(stanza);
	session.conn.addHandler(function(response) {
	    var type = response.getAttribute("type"), code, el = null;
	    if (type == "result") {
		code = 200;
		response.getChildren("pubsub").forEach(function(pubsubEl) {
		    pubsubEl.getChildren("subscription").forEach(function(subscriptionEl) {
			el = subscriptionEl;
		    });
		});
	    } else {
		var code = 502;
		response.getChildren("error").forEach(function(errorEl) {
		    el = errorEl;
		    var codeAttr = errorEl.getAttribute("code");
		    if (codeAttr)
			code = Number(codeAttr);
		});
	    }

	    session.unref(reqId);  // one session process less
	    doneFun(code, el);
	    return false;  // remove listener now
	}, null, "iq", null, id, PUBSUB_SERVICE);
    };
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
	    } else if (req.method == "GET" && req.url == "/pubsub.json") {
		handleWithSession(req, res, account, reqId, setupStreamJSON);
	    } else if (req.method == "POST" && req.url.indexOf("/subscribe/") == 0) {
		var node = decodeURIComponent(req.url.substr("/subscribe/".length));
		sys.puts("node: "+node);
		handleWithSession(req, res, account, reqId,
				  setupRequest(function(session) {
				      return xmpp.iq({type: "set"}).
					  c("pubsub", {xmlns: 'http://jabber.org/protocol/pubsub'}).
					  c("subscribe", {node: node,
							  jid: session.conn.user+'@'+session.conn.server});
				  }, function(code, el) {
				      res.writeHead(code, {"Content-type": "application/xml"});
				      if (el)
					  res.write(el.toString());
				      res.end();
				  }));
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


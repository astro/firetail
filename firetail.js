require.paths.push("deps/node-base64/build/default",
		   "deps/node-expat/build/default",
		   "deps/node-xmpp/lib",
		   "deps/node-router/lib");

var http = require('http');
var sys = require('sys');
var xmpp = require("xmpp");
var base64 = require("base64");
var web = require('node-router').getServer();


var DOMAIN = "superfeedr.com";
var PUBSUB_SERVICE = "firehoser.superfeedr.com";
var SUBSCRIBE_PATH = "/subscriptions";

var defaultXmlns = { '': 'http://www.w3.org/2005/Atom',
		     geo: 'http://www.georss.org/georss',
		     as: 'http://activitystrea.ms/spec/1.0/',
		     sf: 'http://superfeedr.com/xmpp-pubsub-ext'
		   };
var sessions = {};


xmpp.Element.prototype.stripXmlns = function(parentXmlns) {
    for(var prefix in parentXmlns) {
	var xmlnsAttr;
	if (prefix == "")
	    xmlnsAttr = "xmlns";
	else
	    xmlnsAttr = "xmlns:" + prefix;

	/* Remove superfluous xmlns */
	if (this.attrs[xmlnsAttr] == parentXmlns[prefix])
	    delete this.attrs[xmlnsAttr];

	/* Learn all xmlns */
	currentXmlns = Object.create(parentXmlns);
	for(var attr in this.attrs) {
	    var m;
	    if (attr == "xmlns")
		currentXmlns[''] = this.attrs[attr];
	    else if (m = /^xmlns:(.+)/.exec(attr)) {
		var prefix = m[1];
		currentXmlns[prefix] = this.attrs[attr];
	    }
	}
	/* Apply to children */
	this.children = this.children.map(function(el) {
	    if (el.stripXmlns)
		el.stripXmlns(currentXmlns);
	    return el;
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
	sys.puts(user + " " + status);
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

    this.conn = new xmpp.Client({ jid: new xmpp.JID(user, DOMAIN),
				  password: pass
				});
    this.conn.allowTLS = false;  // raw speed is what we need
    var session = this;
    this.conn.addListener('online',
			  function() {
			      session.ready('ok');
			      this.send(new xmpp.Element('presence'));
			  });
    this.conn.addListener('authFail',
			  function() {
			      session.ready('auth');
			  });
    this.conn.addListener('error',
			  function() {
		              session.ready('error');
			  });
    sys.puts("Connect for "+account[0]);

    /* Notification management */
    var notifyCallbacks = {};
    var iqCallbacks = {};
    this.onNotification = function(id, cb) { notifyCallbacks[id] = cb; };
    this.conn.addListener('stanza',
			  function(stanza) {
			      if (stanza.is('message')) {
				  stanza.getChildren("event").forEach(function(eventEl) {
				      eventEl.getChildren("items").forEach(function(itemsEl) {
					  var node = itemsEl.attrs.node;
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
			      } else if (stanza.name == 'iq' &&
					 stanza.attrs.from == PUBSUB_SERVICE) {
				  var id = stanza.attrs.id;
				  if (iqCallbacks[id]) {
				      iqCallbacks[id](stanza);
				      delete iqCallbacks[id];
				  }
			      }
			  });

    this.addIqListener = function(id, cb) {
	iqCallbacks[id.toString()] = cb;
    };

    /* Individual un-using, with shutdown */
    this.unref = function(id) {
	delete readyCallbacks[id];
	delete notifyCallbacks[id];
	delete iqCallbacks[id.toString()];

	/* Are callbacks still registered? */
	for(var id in readyCallbacks)
	    return;
	for(var id in notifyCallbacks)
	    return;
	/* No: */
	sys.puts("Shutdown for "+account[0]);
	sessions[account] = null;
	this.conn.end();
    };
}

function withSession(account, reqId, cb) {
    var session = sessions[account];
    if (!session)
	sessions[account] = session = new Session(account);
    session.onReady(reqId,
		    function(event) {
			sys.puts("event " + event);
			cb(event, session);
		    });
    return session;
}

/* Controllers */
var nextReqId = 0;

function handleWithSession(req, res, cb) {
    var reqId = nextReqId;
    nextReqId++;

    var account = reqAuth(req);
    if (!account) {
	res.writeHead(401, {});
	res.end();
	return;
    }

    var session = withSession(account, reqId,
			      function(event, session) {
				  sys.puts("req " + reqId + " got session with: " + event);
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
    var text = el.attrs[name];
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
				   var json = {via: node};
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
	stanza = iqGenerator(session).root();
	sys.puts("generated: "+stanza.toString());
	stanza.attrs.to = PUBSUB_SERVICE;
	stanza.attrs.id = reqId.toString();
	sys.puts("augmented: "+stanza.toString());
	session.conn.send(stanza);
	session.addIqListener(reqId,
			      function(response) {
				  var type = response.attrs.type, code, el = null;
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
					  var codeAttr = errorEl.attrs.code;
					  if (codeAttr)
					      code = Number(codeAttr);
				      });
				  }

				  session.unref(reqId);  // one session process less
				  doneFun(code, el);
			      });
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

web.get("/pubsub.xml", function(req, res) {
	    handleWithSession(req, res, setupStreamATOM);
	});
web.get("/pubsub.json", function(req, res) {
	    handleWithSession(req, res, setupStreamJSON);
	});
web.post(/\/subscriptions\/(.+)/, function(req, res, node) {
	     node = decodeURIComponent(node);
	     sys.puts("node: "+node);
	     handleWithSession(req, res,
			       setupRequest(function(session) {
						return new xmpp.Element('iq',
						                        {type: "set"}).
						    c("pubsub", {xmlns: 'http://jabber.org/protocol/pubsub'}).
						    c("subscribe", {node: node,
						                    jid: session.conn.jid.bare().toString()});
					    }, function(code, el) {
						res.writeHead(code, {"Content-type": "application/xml"});
						if (el)
						    res.write(el.toString());
						res.end();
					    }));
	 });
web.del(/\/subscriptions\/(.+)/, function(req, res, node) {
	    node = decodeURIComponent(node);
	    sys.puts("node: "+node);
	    handleWithSession(req, res,
		setupRequest(function(session) {
				 return new xmpp.Element('iq', {type: "set"}).
				     c("pubsub", {xmlns: 'http://jabber.org/protocol/pubsub'}).
				     c("unsubscribe", {node: node,
						       jid: session.conn.jid.bare().toString()});
			     }, function(code, el) {
				 res.writeHead(code, {"Content-type": "application/xml"});
				 if (el)
				     res.write(el.toString());
				 res.end();
			     }));
	});
web.listen(8888);


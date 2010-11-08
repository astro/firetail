require.paths.push("deps/node-expat/build/default",
		   "deps/node-xmpp/lib",
		   "deps/node-router/lib");

var http = require('http');
var sys = require('sys');
var xmpp = require("xmpp");
var web = require('node-router').getServer();


var DOMAIN = "superfeedr.com";
var PUBSUB_SERVICE = "firehoser.superfeedr.com";
var NS_PUBSUB = 'http://jabber.org/protocol/pubsub';
var NS_EXT = 'http://superfeedr.com/xmpp-pubsub-ext';

var defaultXmlns = { '': 'http://www.w3.org/2005/Atom',
		     geo: 'http://www.georss.org/georss',
		     as: 'http://activitystrea.ms/spec/1.0/',
		     sf: 'http://superfeedr.com/xmpp-pubsub-ext'
		   };

/* Keep sessions open somewhat longer for batches of non-concurrent
   requests */
var SESSION_LINGER = 1000; // ms

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

/* Global registry of active XMPP sessions per account */
var sessions = {};

function Session(account) {
    var user = account[0], pass = account[1];

    /* Connection management */
    var readyCallbacks = {}, endCallbacks = {};
    this.onReady = function(id, cb) { readyCallbacks[id] = cb; };
    this.onEnd = function(id, cb) { endCallbacks[id] = cb; };
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
			      for(var id in endCallbacks) {
				  endCallbacks[id]();
			      }
			  });
    this.conn.addListener('end',
			  function() {
		              session.ready('error');
			      for(var id in endCallbacks) {
				  endCallbacks[id]();
			      }
			  });
    sys.puts("Connect for "+account[0]);

    /* Notification management */
    var notifyCallbacks = {};
    var iqCallbacks = {};
    this.onNotification = function(id, cb) { notifyCallbacks[id] = cb; };
    this.conn.addListener('stanza',
			  function(stanza) {
			      //sys.puts('STANZA: '+stanza.toString());
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
				      /* First delete, to allow the
				       * callback to reattach itself
				       * with the same iq id again
				       * (serial requests).
				       */
				      var cb = iqCallbacks[id];
				      delete iqCallbacks[id];
				      cb(stanza);
				  }
			      }
			  });

    this.addIqListener = function(id, cb) {
	iqCallbacks[id] = cb;
    };

    /* Individual un-using, with shutdown */
    this.unref = function(id, lingered) {
	if (id) {
	    delete readyCallbacks[id];
	    delete endCallbacks[id];
	    delete notifyCallbacks[id];
	    delete iqCallbacks[id.toString()];
	}

	/* Are callbacks still registered? */
	for(var id in readyCallbacks)
	    return;
	for(var id in notifyCallbacks)
	    return;
	for(var id in iqCallbacks)
	    return;
	/* No: */
	if (!lingered) {
	    var self = this;
	    if (self.endTimer)
		clearTimeout(self.endTimer);
	    self.endTimer = setTimeout(function() { self.unref(null, true); }, SESSION_LINGER);
	} else {
	    sys.puts("Shutdown for "+account[0]);
	    sessions[account] = null;
	    this.conn.end();
	}
    };
}


function withSession(account, reqId, cb) {
    var session = sessions[account];
    if (!session)
	sessions[account] = session = new Session(account);
    else if (session.endTimer)
	clearTimeout(session.endTimer);
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
	    var up = /^(.+?):(.+)/.exec(new Buffer(m[1], 'base64').toString());
	    var user = up[1], pass = up[2];
	    return [user, pass];
	}
	else
	    return null;
    }
    else
	return null;
}

/* Controllers */

var nextReqId = 0;

function Action(req, res) {
    var self = this;

    var account = reqAuth(req);
    if (!account) {
	res.writeHead(401, {});
	res.end();
	return;
    }

    self.res = res;
    self.reqId = nextReqId.toString();
    nextReqId++;

    self.session = withSession(account, self.reqId, function(event, session) { self.onSession(event, session); });
    /* Catch XMPP session termination */
    self.session.onEnd(self.reqId, function() { sys.puts("onEnd"); res.end(); });

    /* Catch HTTP request termination */
    req.socket.addListener('end',
			   function() {
			       sys.puts(self.reqId+" req end");
			       self.session.unref(self.reqId);
			   });
}
Action.prototype.onSession = function(event, session) {
    var self = this;
    self.session = session;
    sys.puts("req " + self.reqId + " got session with: " + event);

    if (event == 'ok') {
	try { self.onOnline(); }
	catch (e) { sys.puts("onOnline: "+e.toString()); }
	if (self.onNotification) {
	    self.session.onNotification(self.reqId,
					function(node, entries) {
					    self.onNotification(node, entries);
					});
	}
    }
    else if (event == 'auth') {
	self.res.writeHead(401, {});
	self.res.end();
    }
    else {
	self.res.writeHead(501, {});
	self.res.end();
    }
};

function AtomStream(req, res) {
    Action.call(this, req, res);
}
sys.inherits(AtomStream, Action);

AtomStream.prototype.onOnline = function() {
    this.res.writeHead(200, {'Content-type': 'application/atom+xml'});
    this.res.write("<feed");
    for(var prefix in defaultXmlns) {
	this.res.write(" xmlns");
	if (prefix != '')
	    this.res.write(":"+prefix);
	this.res.write("=\""+defaultXmlns[prefix]+"\"");
    }
    this.res.write(">\n");
};

AtomStream.prototype.onNotification = function(node, entries) {
    var self = this;
    sys.puts("writing to " + this.res + " for " + node);
    entries.forEach(function(entry) {
	sys.puts("this: "+this.toString());
	entry.c("link", { rel: "via",
			  href: node });
	entry.stripXmlns(defaultXmlns);
	entry.write(function(s) { self.res.write(s); });
	self.res.write("\n");
    });
};

function JsonStream(req, res) {
    Action.call(this, req, res);
}
sys.inherits(JsonStream, Action);

JsonStream.prototype.onOnline = function() {
    this.res.writeHead(200, {'Content-type': 'application/json'});
    this.res._hasBody = true;
};

/*** Helpers for XML to JSON conversion */

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

JsonStream.prototype.onNotification = function(node, entries) {
    var self = this;
    sys.puts("writing to " + this.res + " for " + node);
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
	self.res.write(line.length + "\n" + line);
    });
};

function IqRequest(req, res, stanza, resultFormatter) {
    this.stanza = stanza;
    this.resultFormatter = resultFormatter;
    /* If session already established, this will lead to onOnline()
       immediately */
    Action.call(this, req, res);
}
sys.inherits(IqRequest, Action);

IqRequest.prototype.onOnline = function() {
    var self = this;
    var stanza = self.stanza;
    /* Can either be an XML element or a function that generates one
       with the session */
    if (typeof stanza == 'function')
	stanza = stanza(self.session);
    stanza = stanza.root();

    /* Defaults for all iqs */
    stanza.attrs.to = PUBSUB_SERVICE;
    stanza.attrs.id = self.reqId;

    /* Send... */
    self.session.conn.send(stanza);
    /* ...and wait for response */
    self.session.addIqListener(self.reqId,
			       function(response) { self.onResponse(response); });
};

IqRequest.prototype.onResponse = function(stanza) {
    if (stanza.attrs.type == "result") {
	var self = this;
	self.res.writeHead(200, {"Content-type": "application/xml"});
	self.resultFormatter(stanza,
			     function(s) {
				 self.res.write(s);
			     });
    } else {
	var el, code = 502;
	stanza.getChildren("error").forEach(function(errorEl) {
	    el = errorEl;
	    var codeAttr = errorEl.attrs.code;
	    if (codeAttr)
		code = Number(codeAttr);
	});
	this.res.writeHead(code, {"Content-type": "application/xml"});
	this.res.write(el.toString());
    }

    this.res.end();
    //session.unref(this.reqId);  // one session process less
};


function pubsubElsToString(stanza, writer) {
    stanza.getChildren("pubsub", NS_PUBSUB).forEach(function(pubsubEl) {
	pubsubEl.children.forEach(function(el) {
	    if (el.attrs)
		el.attrs.xmlns = NS_PUBSUB;
	    writer(el.toString());
	});
    });
}

function pubsubItemsToFeed(stanza, writer) {
    writer("<feed");
    for(var prefix in defaultXmlns) {
	writer(" xmlns");
	if (prefix != '')
	    writer(":"+prefix);
	writer("=\""+defaultXmlns[prefix]+"\"");
    }
    writer(">\n");

    stanza.getChildren("pubsub", NS_PUBSUB).forEach(function(eventEl) {
	eventEl.getChildren("items").forEach(function(itemsEl) {
	    itemsEl.getChildren("item").forEach(function(itemEl) {
		itemEl.getChildren("entry").forEach(function(entryEl) {
		    entryEl.stripXmlns(defaultXmlns);
		    entryEl.write(function(s) { writer(s); });
		    writer("\n");
		});
	    });
	});
    });

    writer("</feed>\n");
}

function WalkSubscriptions(req, res) {
    var self = this;
    self.page = 1;
    IqRequest.call(this, req, res, function(session) {
	return new xmpp.Element('iq', {type: "get"}).
	    c("pubsub", {xmlns: NS_PUBSUB,
			 'xmlns:superfeedr': NS_EXT}).
	    c("subscriptions", {jid: session.conn.jid.bare().toString(),
				'superfeedr:page': self.page.toString()});
    }, null);
}
sys.inherits(WalkSubscriptions, IqRequest);

WalkSubscriptions.prototype.onResponse = function(stanza) {
    var self = this;
    if (stanza.attrs.type == "result") {
	if (self.page == 1) {
	    self.res.writeHead(200, {"Content-type": "application/xml"});
	    self.res.write("<subscriptions xmlns='" + NS_PUBSUB +
			   " xmlns:superfeedr='" + NS_EXT +
			   "'>\n");
	}
	var subscriptions = 0, page_ext = false;
	stanza.getChildren("pubsub", NS_PUBSUB).forEach(
	    function(pubsubEl) {
		pubsubEl.getChildren("subscriptions", NS_PUBSUB).forEach(
		    function(subscriptionsEl) {
			page_ext = page_ext || (subscriptionsEl.attrs['superfeedr:page'] == self.page.toString());
			subscriptions += subscriptionsEl.getChildren("subscription").length;
			subscriptionsEl.children.forEach(function(child) {
			    self.res.write(child.toString());
			});
		    });
	    });
	if (page_ext && subscriptions > 0) {
	    /* No empty list, more to come on next page */
	    self.page++;
	    self.onOnline();
	} else {
	    /* Either no superfeedr:page ext or empty list */
	    self.res.write("</subscriptions>\n");
	    self.res.end();
	}
    } else {
	var el, code = 502;
	stanza.getChildren("error").forEach(function(errorEl) {
	    el = errorEl;
	    var codeAttr = errorEl.attrs.code;
	    if (codeAttr)
		code = Number(codeAttr);
	});
	self.res.writeHead(code, {"Content-type": "application/xml"});
	self.res.write(el.toString());
	self.res.end();
    }
};


web.get("/pubsub.xml", function(req, res) { new AtomStream(req, res); });
web.get("/pubsub.json", function(req, res) { new JsonStream(req, res); });
web.get("/archive/(.+)", function(req, res, node) {
    node = decodeURIComponent(node);
    new IqRequest(req, res,
		  new xmpp.Element('iq', {type: "get"}).
		      c("pubsub", {xmlns: NS_PUBSUB}).
		      c("items", {node: node}),
		  pubsubItemsToFeed);
});
web.get(/^\/subscriptions/, function(req, res) {
    new WalkSubscriptions(req, res);
});
web.post(/^\/subscriptions\/(.+)/, function(req, res, node) {
    node = decodeURIComponent(node);
    sys.puts("NODE: "+node);
    new IqRequest(req, res,
		  function(session) {
		      return new xmpp.Element('iq', {type: "set"}).
			  c("pubsub", {xmlns: NS_PUBSUB}).
			  c("subscribe", {node: node,
					  jid: session.conn.jid.bare().toString()});
		  }, pubsubElsToString);
});
web.del(/^\/subscriptions\/(.+)/, function(req, res, node) {
    node = decodeURIComponent(node);
    new IqRequest(req, res,
		  function(session) {
		      return new xmpp.Element('iq', {type: "set"}).
			  c("pubsub", {xmlns: NS_PUBSUB}).
			  c("unsubscribe", {node: node,
					    jid: session.conn.jid.bare().toString()});
		  }, pubsubElsToString);
});
web.listen(8888);


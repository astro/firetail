# FireTail
An HTTP REST to XMPP PubSub gateway for server-side JavaScript.

## Requirements
* [node.js](http://github.com/ry/node)
* My branch of [xmppjs](http://github.com/astro/xmppjs)
* [node-xml](http://github.com/robrighter/node-xml) for xmppjs
* [node-base64](http://github.com/brainfucker/node-base64)

## Usage
First, set your Superfeedr.com credentials:
    export CREDS=superusr:secret

Attach to the ATOM firehose:
    curl -u $CREDS http://localhost:8888/pubsub.xml
Also available in a Twitter-style JSON format interleaved with line lengths:
    curl -u $CREDS http://localhost:8888/pubsub.json

Subscribe to a (url-encoded) node:
    curl -u $CREDS -X POST http://localhost:8888/subscription/http%3A%2F%2Ftwitter.com%2Fstatuses%2Fuser_timeline%2F61287780.rss
Unsubscribe from a node:
    curl -u $CREDS -X DELETE http://localhost:8888/subscription/http%3A%2F%2Ftwitter.com%2Fstatuses%2Fuser_timeline%2F61287780.rss

## TODO
* Improve xmppjs
* Expose [PubSub archive functionality](http://xmpp.org/extensions/xep-0060.html#subscriber-retrieve-requestall)
* Implement deflate encoding/compression
* Add proper keep-alive support (in http.js?)

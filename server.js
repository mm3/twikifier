/*jslint unparam: true, indent: 4, node: true */

"use strict";

process.title = 'twikifier'; // helpful for watching top and ps

var net = require('net'),
	fs = require('fs'),
	jsdom = require('jsdom'),
	jquery = require('jQuery'),
	http = require('http'),
	url = require('url'),
	Memcached = require('memcached'),
	crypto = require('crypto'),
	uuid = require('node-uuid'),
	twikifier = require('./twikifier'),
	twik = require('./twik');

var Emitter = require('events').EventEmitter,
	server = net.createServer({allowHalfOpen: true}),
	memcache = new Memcached('127.0.0.1:11211'),
	socketPath = '/tmp/wst.sock',
	getData;

var formatText = function(place, wikify, text, tiddler) {
	wikify(text, place, null, tiddler);
	return place.innerHTML;
};

var sha1Hex = function(input) {
	var hashMaker = crypto.createHash('sha1');
	return hashMaker.update(input).digest('hex');
};

var processData = function(store, tiddlerText, wikify, jQuery) {
	var place = jQuery("<div>"),
		output = formatText(place[0], wikify, tiddlerText);

	place.remove();

	return output;
};

// use a bag's namespace if possible, otherwise use any
var getNamespace = function(uri) {
	var match = /\/(bags|recipes)\/([^\/]+)/.exec(uri),
		namespace;

	if (!match || match[1] === 'recipes') {
		namespace = 'any_namespace';
	} else {
		namespace = match[1] + ':' + match[2] + '_namespace';
	}
	return sha1Hex(namespace);
};

var processRequest = function(args, emitter) {
	emitter = emitter || new Emitter();
	return {emitter: emitter, action: function () {

		var window = jsdom.jsdom('<html><head></head><body></body></html>')
				.createWindow(),
			jQuery = jquery.create(window), // jQuery-ize the window
			collection_uri = args[0],
			tiddlerText = args[1],
			tiddlyweb_cookie = args[2] || '',
			globals = twikifier.createWikifier(window, jQuery,
					{container: collection_uri}),
			namespace = getNamespace(collection_uri),
			wikify = globals[0],
			store = globals[1],
			Tiddler = globals[2];

		if (!memcache) {
			getData(memcache, collection_uri, tiddlyweb_cookie, emitter, store,
					Tiddler, tiddlerText, wikify, false, jQuery);
		} else {
			memcache.get(namespace, function(err, result) {
				if (err) {
					console.error(err);
					emitter.emit('output', 'Error getting namespace key ' + err);
				} else {
					if (!result) {
						result = uuid();
						memcache.set(namespace, result, 0, function(err, result) {
							if (err) {
								console.error(err);
							}
							if (result) {
								var output = processRequest(args, emitter);
								output.action();
							}
							getData(memcache, collection_uri,
								tiddlyweb_cookie, emitter, store, Tiddler,
								tiddlerText, wikify, false, jQuery);
						});
					} else {
						var memcacheKey = sha1Hex(result + collection_uri);
						memcache.get(memcacheKey, function(err, result) {
							if (err) {
								console.error(err);
								emitter.emit('output',
									'Error getting collection key ' + err);
							} else {
								var data = result;
								if (!data) {
									getData(memcache, collection_uri,
										tiddlyweb_cookie, emitter, store, Tiddler,
										tiddlerText, wikify, memcacheKey, jQuery);
								} else {
									console.log('using cache for', collection_uri);
									twik.loadRemoteTiddlers(store, Tiddler,
										collection_uri, data);
									emitter.emit('output',
										processData(store, tiddlerText, wikify, jQuery));
								}
							}
						});
					}
				}
			});
		}
	}};
};

getData = function(memcache, collection_uri, tiddlyweb_cookie,
		emitter, store, Tiddler, tiddlerText, wikify, memcacheKey, jQuery) {
	if (/<</.test(tiddlerText)) {
		console.log('not using cache for', collection_uri);
		var parsed_uri = url.parse(collection_uri),
			request_options = {
				hostname: parsed_uri.hostname,
				port: parsed_uri.port || 80,
				method: 'GET',
				path: parsed_uri.pathname,
				headers: {
					'host': parsed_uri.hostname,
					'accept': 'application/json',
					'cookie': tiddlyweb_cookie,
					'user-agent': 'twikifier server.js',
					'x-controlview': 'false'
				}
			},
			request = http.request(request_options, function(response) {
				if (response.statusCode === '302' &&
						response.headers.location.indexOf('/challenge')) {
					emitter.emit('output', processData(store,
							tiddlerText, wikify, jQuery));
				} else {
					response.setEncoding('utf8');
					var content = '';
					response.on('data', function(chunk) {
						content += chunk;
					});
					response.on('end', function() {
						if (memcache !== 'undefined' && memcacheKey) {
							memcache.set(memcacheKey, content, 0, function() {});
						}
						twik.loadRemoteTiddlers(store, Tiddler,
							collection_uri, content);
						var output = processData(store, tiddlerText,
							wikify, jQuery);
						emitter.emit('output', output);
					});
				}
			});

		request.on('error', function(err) {
			emitter.emit('output', processData(store, tiddlerText,
					wikify, jQuery));
		});
		request.end();
	} else {
		emitter.emit('output', processData(store, tiddlerText, wikify, jQuery));
	}
};

server.addListener('connection', function(c) {
	var data = '';
	c.addListener('timeout', function() {
		c.end('timeout on socket communication');
		c.destroy();
		console.error('timeout event on connection', c);
	});
	c.addListener('error', function(err) {
		c.end('error event on connection');
		c.destroy();
		console.error('error event on connection', c, err);
	});
	c.addListener('data', function(chunk) {
		data += chunk;
	});
	c.addListener('end', function() {
		var dataString = data.toString().replace(/(\r|\n)+$/, ''),
			args = dataString.split(/\x00/),
			output = processRequest(args);
		output.emitter.on('output', function(data) {
			c.end(data);
			c.destroy();
		});
		output.action();
	});
	// timeout after 10 seconds of inactivity
	c.setTimeout(10000);
});

// unlink the socket before starting
fs.unlink(socketPath, function() {
	server.maxConnections = 50;
	server.listen(socketPath);
});

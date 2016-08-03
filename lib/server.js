"use strict";

/*
 * HyperSwitch web service entry point
 *
 * Sets up a HyperSwitch instance by loading and setting up handlers and the
 * storage layer, and then dispatches requests to it.
 */

var P = require('bluebird');
var Busboy = require('busboy');
var qs = require('querystring');
var url = require('url');
var http = require('http');
var zlib = require('zlib');
var stream = require('stream');

var URI = require('swagger-router').URI;

var exports = require('./exports');
var HyperSwitch = require('./hyperswitch');
var Router = require('./router');
var utils = require('./utils');


// Should make it into 0.12, see https://github.com/joyent/node/pull/7878
var SIMPLE_PATH = /^(\/(?!\/)[^\?#\s]*)(?:\?([^#\s]*))?$/;
function parseURL(uri) {
    // Fast path for simple path uris
    var fastMatch = SIMPLE_PATH.exec(uri);
    if (fastMatch) {
        return {
            protocol: null,
            slashes: null,
            auth: null,
            host: null,
            port: null,
            hostname: null,
            hash: null,
            search: fastMatch[2] || '',
            pathname: fastMatch[1],
            path: fastMatch[1],
            query: fastMatch[2] && qs.parse(fastMatch[2]) || {},
            href: uri
        };
    } else {
        return url.parse(uri, true);
    }
}


/**
 * Parse a POST request into request.body with BusBoy
 * Drops file uploads on the floor without creating temporary files
 *
 * @param {Request} req HTTP request
 * @returns {Promise<>}
 */
function read(req) {
    return new P(function(resolve) {
        var chunks = [];
        req.on('data', function(chunk) {
            chunks.push(chunk);
        });

        req.on('end', function() {
            resolve(Buffer.concat(chunks));
        });
    });
}

function parsePOST(req) {
    var readIt = (req.method === 'PUT') ||
        (req.method === 'POST' && req.headers &&
            (/^application\/json/i.test(req.headers['content-type'])
            || !req.headers['content-type']));

    if (readIt) {
        return read(req);
    } else if (req.method !== 'POST') {
        return P.resolve();
    } else {
        // Parse the POST
        return new P(function(resolve) {
            // Parse POST data
            var bboy = new Busboy({
                headers: req.headers,
                // Increase the form field size limit from the 1M default.
                limits: { fieldSize: 15 * 1024 * 1024 }
            });
            var body = {};
            bboy.on('field', function(field, val) {
                body[field] = val;
            });
            bboy.on('finish', function() {
                resolve(body);
            });
            req.pipe(bboy);
        });
    }
}

function logResponse(opts, response, startTime) {
    var latency = Date.now() - startTime;
    var logLevel = 'trace/request';
    if (latency > 5000) {
        logLevel = 'trace/request/slow';
    }
    opts.log(logLevel, {
        message: response.message || 'Request sample',
        res: {
            status: response.status,
            headers: response.headers,
        },
        stack: response.stack,
        latency: latency,
    });

    if (response.status >= 500) {
        opts.log('error/request', {
            message: response.message,
            res: response,
            stack: response.stack,
            latency: latency,
        });
    }
}

/**
 * Set up basic CORS in response headers
 *
 * @param {Object} rh Response headers object
 * @private
 */
function setCORSHeaders(rh) {
    rh['access-control-allow-origin'] = '*';
    rh['access-control-allow-methods'] = 'GET';
    rh['access-control-allow-headers'] = 'accept, content-type';
    rh['access-control-expose-headers'] = 'etag';
}

function handleResponse(opts, req, resp, response) {
    if (response && response.status) {
        var rh = response.headers = response.headers || {};

        utils.removeHopToHopHeaders(rh, false);
        setCORSHeaders(rh);

        // Default to no server-side caching
        rh['cache-control'] = rh['cache-control']
            || 'private, max-age=0, s-maxage=0, must-revalidate';

        // Set up security headers
        // https://www.owasp.org/index.php/List_of_useful_HTTP_headers
        rh['x-content-type-options'] = 'nosniff';
        rh['x-frame-options'] = 'SAMEORIGIN';

        exports.misc.addCSPHeaders(response, { domain: req.params && req.params.domain });

        // Propagate the request id header
        rh['x-request-id'] = opts.reqId;

        logResponse(opts, response, opts.startTime);

        var body;
        // Prepare error responses for the client
        if (response.status >= 400) {
            rh['content-type'] = rh['content-type']
                || 'application/problem+json';

            // Whitelist fields to avoid leaking sensitive info
            var rBody = response.body || {};
            body = {
                type: rBody.type,
                title: rBody.title,
                method: rBody.method || req.method,
                detail: rBody.detail || rBody.description,
                uri: rBody.uri || req.uri
            };
            if (response.status === 404) {
                body.type = body.type || 'not_found';
                body.title = body.title || 'Not found.';
            }
            body.type = body.type || 'unknown_error';

            // Prefix error base URL
            if (!/^https?:\/\//.test(body.type)) {
                body.type = (opts.conf.default_error_uri
                        || 'https://mediawiki.org/wiki/HyperSwitch/errors/')
                    + body.type;
            }
            response.body = body;
        }

        if (req.method === 'head') {
            response.body = null;
        }

        if (opts.metrics) {
            opts.metrics.endTiming([
                'ALL.ALL',
                req.method.toUpperCase() + '.' + response.status.toString()
            ], opts.startTime);
        }

        if (response.body) {
            body = response.body;
            var bodyIsStream = body instanceof stream.Readable;
            if (!Buffer.isBuffer(body) && !bodyIsStream) {
                // Convert to a buffer
                if (typeof body === 'object') {
                    rh['content-type'] = rh['content-type'] || 'application/json';
                    body = new Buffer(JSON.stringify(body));
                } else {
                    body = new Buffer(body);
                }
            }

            var cType = rh['content-type'];
            if (/\bgzip\b/.test(req.headers['accept-encoding'])
                    && /^application\/json\b|^text\//.test(cType)
                    && rh['content-encoding'] !== 'gzip') {
                rh['content-encoding'] = 'gzip';
                resp.writeHead(response.status, '', rh);
                var zStream = zlib.createGzip({ level: 3 });
                zStream.pipe(resp);
                if (bodyIsStream) {
                    body.pipe(zStream);
                } else {
                    zStream.end(body);
                }
            } else if (rh['content-encoding'] === 'gzip'
                    && !/\bgzip\b/.test(req.headers['accept-encoding'])) {
                delete rh['content-encoding'];
                resp.writeHead(response.status, '', rh);
                var unzStream = zlib.createGunzip();
                unzStream.pipe(resp);
                if (bodyIsStream) {
                    body.pipe(unzStream);
                } else {
                    unzStream.end(body);
                }
            } else if (bodyIsStream) {
                resp.writeHead(response.status, '', rh);
                body.pipe(resp);
            } else {
                rh['content-length'] = body.length;
                resp.writeHead(response.status, '', rh);
                resp.end(body);
            }
        } else {
            resp.writeHead(response.status, '', rh);
            resp.end();
        }
    } else {
        opts.log('error/request', {
            root_req: req,
            msg: "No content returned"
        });

        response = response || {};
        response.headers = response.headers || {};
        response.headers['content-type'] = 'application/problem+json';

        resp.writeHead(response.status || 500, '', response.headers);
        resp.end(req.method === 'head' ? undefined : JSON.stringify({
            type: 'server_error#empty_response',
            title: 'HyperSwitch error: No content returned by backend.',
            uri: req.url,
            method: req.method
        }));
    }
}

// Handle a single request
function handleRequest(opts, req, resp) {
    // Set the request ID early on for external requests
    req.headers = req.headers || {};
    req.headers['x-request-id'] = req.headers['x-request-id'] || utils.generateRequestId();

    var remoteAddr = req.headers['x-client-ip'] || req.socket.remoteAddress;
    req.headers['x-client-ip'] = remoteAddr;
    var xff = req.headers['x-forwarded-for'];
    if (xff) {
        // Prepend current client to XFF, so that it is passed on in
        // sub-requests.
        req.headers['x-forwarded-for'] = xff + ', ' + req.socket.remoteAddress;
    } else {
        req.headers['x-forwarded-for'] = req.socket.remoteAddress;
    }

    var reqOpts = {
        conf: opts.conf,
        log: null,
        reqId: req.headers['x-request-id'],
        metrics: opts.metrics,
        ratelimiter: opts.ratelimiter,
        startTime: Date.now()
    };

    /**
     * We use separate metric trees for requests from private networks, so
     * that we can separately study performance for those different use cases.
     * We implement this by passing a specialized prefixed metric producer to
     * the handler. All derived metrics associated with a private / update
     * request are thus recorded in .internal or .internal_update prefixed
     * metric trees.
     */
    if (/^(?:::ffff:)?(?:10|127)\./.test(remoteAddr)) {
        if (req.headers['cache-control'] && /no-cache/i.test(req.headers['cache-control'])) {
            reqOpts.metrics = opts.child_metrics.internal_update;
            req.headers['x-request-class'] = 'internal_update';
        } else {
            reqOpts.metrics = opts.child_metrics.internal;
            req.headers['x-request-class'] = 'internal';
        }
    } else {
        reqOpts.metrics = opts.child_metrics.external;
        req.headers['x-request-class'] = 'external';
    }

    // Create a child logger with selected request information.
    reqOpts.logger = opts.logger && opts.logger.child({
        root_req: {
            method: req.method.toLowerCase(),
            uri: req.url,
            headers: {
                'cache-control': req.headers['cache-control'],
                'content-length': req.headers['content-length'],
                'content-type': req.headers['content-type'],
                'if-match': req.headers['if-match'],
                'user-agent': req.headers['user-agent'],
                'x-client-ip': req.headers['x-client-ip'],
                'x-forwarded-for': req.headers['x-forwarded-for'],
                'x-request-id': req.headers['x-request-id'],
                'x-request-class': req.headers['x-request-class'],
                'x-triggered-by': req.headers['x-triggered-by']
            },
        },
        request_id: req.headers['x-request-id']
    });
    reqOpts.log = reqOpts.logger && reqOpts.logger.log.bind(reqOpts.logger) || function() {};

    // Create a new, clean request object
    var urlData = parseURL(req.url);

    var newReq = {
        uri: new URI(urlData.pathname),
        query: urlData.query,
        method: req.method.toLowerCase(),
        headers: req.headers
    };

    // Start off by parsing any POST data with BusBoy
    return parsePOST(req)
    .catchThrow(new exports.HTTPError({
        status: 400,
        body: {
            type: 'invalid_request'
        }
    }))

    // Then process the request
    .then(function(body) {

        if (body && /^application\/json/i.test(req.headers['content-type'])) {
            var bodyStr = body.toString();
            if (bodyStr) {
                try {
                    body = JSON.parse(bodyStr);
                } catch (e) {
                    reqOpts.log('error/request/json-parsing', e);
                }
            }
        }

        newReq.body = body;

        // Quick hack to set up general CORS
        if (newReq.method === 'options') {
            return P.resolve({
                status: 200
            });
        } else {
            return opts.hyper.request(newReq, reqOpts);
        }
    })

    // And finally handle the response
    .then(function(result) {
        return handleResponse(reqOpts, newReq, resp, result);
    })
    .catch(function(e) {
        if (!e || e.name !== 'HTTPError') {
            var originalError = e;
            var stack = e && e.stack;
            e = new exports.HTTPError({
                status: 500,
                body: {
                    type: 'internal_error',
                    description: e + ''
                    // Probably better to keep this private for now
                    // stack: e.stack
                }
            });
            // Log this internally
            e.stack = stack;
            e.innerError = originalError;
        }
        if (!e.status) {
            e.status = 500;
        }
        return handleResponse(reqOpts, newReq, resp, e);
    });
}

// Main app setup
function main(options) {
    var conf = options.config || {};
    // Set up the global options object with a logger
    conf.service_name = options.name || 'HyperSwitch Service';
    conf.docs_name = conf.docs_name
        || conf.service_name[0].toUpperCase() + conf.service_name.substr(1);
    var opts = {
        appBasePath: options.appBasePath,
        conf: conf,
        logger: options.logger,
        log: options.logger && options.logger.log.bind(options.logger) || function() {},
        metrics: options.metrics,
        ratelimiter: options.ratelimiter,
        child_metrics: {
            external: options.metrics && options.metrics.makeChild('external'),
            internal: options.metrics && options.metrics.makeChild('internal'),
            internal_update: options.metrics && options.metrics.makeChild('internal_update'),
        }
    };

    main.server = http.createServer(handleRequest.bind(null, opts));
    main.server.maxConnections = 500;

    opts.router = new Router(opts);
    opts.hyper = new HyperSwitch(opts);
    // Use a child HyperSwitch instance to sidestep the security protection for
    // direct requests to /sys
    var childHyperSwitch = opts.hyper.makeChild({ uri: '#internal-startup' }, {
        metrics: options.metrics && options.metrics.makeChild('internal_startup')
    });

    // Main app startup happens during async spec loading:
    return opts.router.loadSpec(conf.spec, childHyperSwitch)
    .then(function() {
        // Use a large listen queue
        // Also, echo 1024 | sudo tee /proc/sys/net/core/somaxconn
        // (from 128 default)
        var port = conf.port || 7231;
        var host = conf.host;
        // Apply some back-pressure.
        main.server.listen(port, host);
        opts.log('warn/startup', 'listening on ' + (host || '*') + ':' + port);
        return main.server;
    })
    .catch(function(e) {
        opts.log('fatal/startup', {
            status: e.status,
            err: e,
            stack: e.body && e.body.stack || e.stack
        });
        // Delay exiting to avoid heavy restart load & let the logger finish its business
        setTimeout(function() {
            process.exit(1);
        }, 2000);
    });
}

if (module.parent === null) {
    main();
} else {
    module.exports = main;
}

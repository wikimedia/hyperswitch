'use strict';

/*
 * HyperSwitch web service entry point
 *
 * Sets up a HyperSwitch instance by loading and setting up handlers and the
 * storage layer, and then dispatches requests to it.
 */

const P = require('bluebird');
const Busboy = require('busboy');
const qs = require('querystring');
const url = require('url');
const http = require('http');
const zlib = require('zlib');
const stream = require('stream');
const os = require('os');

const URI = require('swagger-router').URI;

const exporting = require('./exports');
const HyperSwitch = require('./hyperswitch');
const Regex = require('./regex');
const Router = require('./router');
const utils = require('./utils');

// Should make it into 0.12, see https://github.com/joyent/node/pull/7878
const SIMPLE_PATH = /^(\/(?!\/)[^?#\s]*)(?:\?([^#\s]*))?$/;
function parseURL(uri) {
    // Fast path for simple path uris
    const fastMatch = SIMPLE_PATH.exec(uri);
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
 * @param  {Request} req HTTP request
 * @return {Promise}
 */
function read(req) {
    return new P((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => {
            chunks.push(chunk);
        });

        req.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
    });
}

function parsePOST(req) {
    const readIt = (req.method === 'PUT') ||
        (req.method === 'POST' && req.headers &&
            (/^application\/json/i.test(req.headers['content-type']) ||
                !req.headers['content-type']));

    if (readIt) {
        return read(req);
    } else if (req.method !== 'POST') {
        return P.resolve();
    } else {
        // Parse the POST
        return new P((resolve) => {
            // Parse POST data
            const bboy = new Busboy({
                headers: req.headers,
                // Increase the form field size limit from the 1M default.
                limits: { fieldSize: 15 * 1024 * 1024 }
            });
            const body = {};
            bboy.on('field', (field, val) => {
                body[field] = val;
            });
            bboy.on('finish', () => {
                resolve(body);
            });
            req.pipe(bboy);
        });
    }
}

function logResponse(opts, response, startTime) {
    const latency = Date.now() - startTime;
    let logLevel = 'debug/request';
    if (latency > 5000) {
        logLevel = 'debug/request/slow';
    }
    opts.logger.log(logLevel, {
        message: response.message || 'Request sample',
        res: {
            status: response.status,
            headers: response.headers
        },
        stack: response.stack,
        latency
    });

    if (response.status >= 500) {
        opts.logger.log('error/request', {
            message: response.message,
            res: response,
            stack: response.stack,
            latency
        });
    }
}

function handleResponse(opts, req, resp, response) {
    if (response && response.status) {
        const rh = response.headers = response.headers || {};

        utils.removeHopToHopHeaders(rh, false);

        // Default to no server-side caching
        rh['cache-control'] = rh['cache-control'] ||
            'private, max-age=0, s-maxage=0, must-revalidate';

        // Propagate the request id header
        rh['x-request-id'] = opts.reqId;

        rh.server = os.hostname();

        logResponse(opts, response, opts.startTime);

        let body;
        // Prepare error responses for the client
        if (response.status >= 400) {
            rh['content-type'] = 'application/problem+json';

            // Whitelist fields to avoid leaking sensitive info
            const rBody = typeof response.body === 'object' && response.body || {};
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
                body.type = (opts.conf.default_error_uri ||
                        'https://mediawiki.org/wiki/HyperSwitch/errors/') +
                    body.type;
            }
            response.body = body;
        }

        if (req.method === 'head') {
            response.body = null;
        }

        if (response.body) {
            body = response.body;
            const bodyIsStream = body instanceof stream.Readable;
            if (!Buffer.isBuffer(body) && !bodyIsStream) {
                // Convert to a buffer
                if (typeof body === 'object') {
                    rh['content-type'] = rh['content-type'] || 'application/json';
                    body = Buffer.from(JSON.stringify(body));
                } else {
                    body = Buffer.from(body);
                }
            }

            const cType = rh['content-type'];
            if (/\bgzip\b/.test(req.headers['accept-encoding']) &&
                    /^application\/json\b|^text\//.test(cType) &&
                    rh['content-encoding'] !== 'gzip') {
                rh['content-encoding'] = 'gzip';
                resp.writeHead(response.status, '', rh);
                const zStream = zlib.createGzip({ level: 3 });
                zStream.pipe(resp);
                if (bodyIsStream) {
                    body.pipe(zStream);
                } else {
                    zStream.end(body);
                }
            } else if (rh['content-encoding'] === 'gzip' &&
                    !/\bgzip\b/.test(req.headers['accept-encoding'])) {
                delete rh['content-encoding'];
                resp.writeHead(response.status, '', rh);
                const unzStream = zlib.createGunzip();
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
        opts.logger.log('error/request', {
            root_req: req,
            response: response.stack || response.toString(),
            msg: 'No content returned'
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

    const remoteAddr = req.headers['x-client-ip'] || req.socket.remoteAddress;
    req.headers['x-client-ip'] = remoteAddr;
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        // Prepend current client to XFF, so that it is passed on in
        // sub-requests.
        req.headers['x-forwarded-for'] = `${xff}, ${req.socket.remoteAddress}`;
    } else {
        req.headers['x-forwarded-for'] = req.socket.remoteAddress;
    }

    const reqOpts = {
        conf: opts.conf,
        reqId: req.headers['x-request-id'],
        metrics: opts.metrics,
        requestClass: 'internal',
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
    if (Regex.LOCAL_IP.test(remoteAddr)) {
        if (req.headers['cache-control'] && /no-cache/i.test(req.headers['cache-control'])) {
            reqOpts.requestClass = 'internal_update';
            req.headers['x-request-class'] = 'internal_update';
        } else {
            req.headers['x-request-class'] = 'internal';
        }
    } else {
        reqOpts.requestClass = 'external';
        req.headers['x-request-class'] = 'external';
    }

    // Create a child logger with selected request information.
    reqOpts.logger = opts.logger.child({
        root_req: {
            method: req.method.toLowerCase(),
            uri: req.url,
            headers: {
                'cache-control': req.headers['cache-control'],
                'content-length': req.headers['content-length'],
                'content-type': req.headers['content-type'],
                'if-match': req.headers['if-match'],
                'user-agent': req.headers['user-agent'],
                'api-user-agent': req.headers['api-user-agent'],
                'x-client-ip': req.headers['x-client-ip'],
                'x-forwarded-for': req.headers['x-forwarded-for'],
                'x-request-id': req.headers['x-request-id'],
                'x-request-class': req.headers['x-request-class'],
                'x-triggered-by': req.headers['x-triggered-by']
            }
        },
        request_id: req.headers['x-request-id']
    });

    // Create a new, clean request object
    const urlData = parseURL(req.url);

    const newReq = {
        uri: new URI(urlData.pathname),
        query: urlData.query,
        method: req.method.toLowerCase(),
        headers: req.headers
    };

    // Start off by parsing any POST data with BusBoy
    return parsePOST(req)
    .catchThrow(new exporting.HTTPError({
        status: 400,
        body: {
            type: 'invalid_request'
        }
    }))

    // Then process the request
    .then((body) => {

        if (body && /^application\/json/i.test(req.headers['content-type'])) {
            const bodyStr = body.toString();
            if (bodyStr) {
                try {
                    body = JSON.parse(bodyStr);
                } catch (e) {
                    reqOpts.logger.log('error/request/json-parsing', e);
                }
            }
        }

        newReq.body = body;

        return opts.hyper.request(newReq, reqOpts);
    })

    // And finally handle the response
    .then((result) => {
        return handleResponse(reqOpts, newReq, resp, result);
    })
    .catch((e) => {
        if (!e || e.name !== 'HTTPError') {
            e = exporting.HTTPError.fromError(e);
        }
        if (!e.status) {
            e.status = 500;
        }
        return handleResponse(reqOpts, newReq, resp, e);
    });
}

// Main app setup
function main(options) {
    const conf = options.config || {};
    // Set up the global options object with a logger
    conf.service_name = options.name;
    const opts = {
        appBasePath: options.appBasePath,
        conf,
        logger: options.logger || utils.nullLogger,
        metrics: options.metrics,
        ratelimiter: options.ratelimiter
    };

    const server = main.server = http.createServer(handleRequest.bind(null, opts));
    server.maxConnections = 500;

    opts.router = new Router(opts);
    opts.hyper = new HyperSwitch(opts);
    // Use a child HyperSwitch instance to sidestep the security protection for
    // direct requests to /sys
    const childHyperSwitch = opts.hyper.makeChild({ uri: '#internal-startup' },
        { requestClass: 'internal_startup' });

    // Main app startup happens during async spec loading:
    return opts.router.loadSpec(conf.spec, childHyperSwitch)
    .then(() => {
        // Use a large listen queue
        // Also, echo 1024 | sudo tee /proc/sys/net/core/somaxconn
        // (from 128 default)
        const port = conf.port || 7231;
        const host = conf.host;
        // Apply some back-pressure.
        server.listen(port, host);
        opts.logger.log('warn/startup', `listening on ${host || '*'}:${port}`);
        // Don't delay incomplete packets for 40ms (Linux default) on
        // pipelined HTTP sockets. We write in large chunks or buffers, so
        // lack of coalescing should not be an issue here.
        server.on('connection', (socket) => {
            socket.setNoDelay(true);
        });

        // Bump up the default socket timeout from 2 minutes to 6 minutes, so
        // that timeout responses at the HTTP level are actually returned
        // before the socket is closed. 6 minutes is the default http request
        // timeout in mainstream browsers, so there is no point in waiting
        // beyond that in browser-targeted services. Which is all of the ones
        // we care about, really.
        server.setTimeout(6 * 60 * 1000);
        return server;
    })
    .catch((e) => {
        opts.logger.log('fatal/startup', {
            status: e.status,
            err: e,
            stack: e.body && e.body.stack || e.stack
        });
        // Delay exiting to avoid heavy restart load & let the logger finish its business
        setTimeout(() => {
            process.exit(1);
        }, 2000);
    });
}

if (module.parent === null) {
    main();
} else {
    module.exports = main;
}

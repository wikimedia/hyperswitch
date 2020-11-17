'use strict';

/*
 * HyperSwitch request dispatcher and general shared per-request state namespace
 */

const P = require('bluebird');
const utils = require('./utils');
const HTTPError = require('./exports').HTTPError;
const swaggerUI = require('./swaggerUI');
const URI = require('swagger-router').URI;

/**
 * Create a uniform but shallow request object copy with sane defaults. This
 * keeps code dealing with this request monomorphic (good for perf), and
 * avoids subtle bugs when requests shared between recursive requests are
 * mutated in another control branch. At the very minimum, we are mutating the
 * @param {Object} req original request object
 * @return {Object} a shallow copy of a provided requests
 */
function cloneRequest(req) {
    const newReq = Object.assign({}, req);
    newReq.url = undefined;
    newReq.uri = req.uri || req.url || null;
    newReq.method = req.method || 'get';
    newReq.headers = req.headers || {};
    newReq.query = req.query || {};
    newReq.body = req.body !== undefined ? req.body : null;
    newReq.params = req.params || {};
    return newReq;
}

class HyperSwitch {
    constructor(options, req, parOptions) {
        if (options && options.constructor === HyperSwitch) {
            // Child instance
            const par = options;
            parOptions = parOptions || {};
            this.logger = parOptions.logger || par.logger;
            this.metrics = parOptions.metrics || par.metrics;
            this.ratelimiter = parOptions.ratelimiter || par.ratelimiter;
            this.reqId = par.reqId ||
                req && req.headers && req.headers['x-request-id'] ||
                utils.generateRequestId();
            this.requestClass = parOptions.requestClass || par.requestClass;

            this._parent = par;
            // Remember the request that led to this child instance at each level, so
            // that we can provide nice error reporting and tracing.
            this._req = req;
            this._recursionDepth = par._recursionDepth + 1;
            this._priv = par._priv;
            this.config = this._priv.options.conf;
            this._rootReq = par._rootReq || req;
            this._rootReq.headers = this._rootReq.headers || {};
            this._requestFilters = par._requestFilters;
            this._subRequestFilters = par._subRequestFilters;
            this.ctx = par.ctx || {
                headers: {
                    'user-agent': req.headers['user-agent'],
                    'x-client-ip': req.headers['x-client-ip']
                }
            };
        } else {
            // Brand new instance
            this.logger = options.logger;
            this.metrics = options.metrics;
            this.ratelimiter = options.ratelimiter;
            this.reqId = null;
            this.requestClass = parOptions && parOptions.requestClass || 'internal';

            // Private
            this._parent = null;
            this._req = null;
            this._recursionDepth = 0;

            options.maxDepth = options.maxDepth || 10;

            // Private state, shared with child instances
            this._priv = {
                options,
                router: options.router
            };

            this.config = options.conf;
            this.config.user_agent = this.config.user_agent || 'HyperSwitch';
            // TODO for v >= 0.8.0: replace the next three defaults with HyperSwitch values
            this.config.ui_name = this.config.ui_name || 'RESTBase';
            this.config.ui_url = this.config.ui_url || 'https://www.mediawiki.org/wiki/RESTBase';
            this.config.ui_title = this.config.ui_title || 'RESTBase docs';
            this._rootReq = null;
            this._requestFilters = [];
            this._subRequestFilters = [];
            this.ctx = parOptions && parOptions.ctx || null;
        }
    }

    // Sets the request id for this instance and adds it to
    // the request header, if defined
    setRequestId(req) {

        req.headers = req.headers || {};
        if (req.headers['x-request-id']) {
            return;
        }
        req.headers['x-request-id'] = this.reqId;

    }

    // Make a child instance
    makeChild(req, options) {
        return new HyperSwitch(this, req, options);
    }

    /**
     * Checks if the maximum recursion depth has been exceeded by the request.
     * If yes, the 500 error is thrown, othervise this is a no-op
     * @param {Object} req - a current request object
     * @private
     */
    _checkMaxRecursionDepth(req) {
        if (this._recursionDepth > this._priv.options.maxDepth) {
            const parents = [];
            let rb = this._parent;
            while (rb) {
                parents.push(rb._req);
                rb = rb._parent;
            }
            throw new HTTPError({
                status: 500,
                body: {
                    type: 'server_error#request_recursion_depth_exceeded',
                    title: 'HyperSwitch request recursion depth exceeded.',
                    parents,
                    depth: this._recursionDepth
                }
            });
        }
    }

    /**
     * Protects /sys APIs from the direct access.
     * @param {Object} req - an original request
     * @private
     */
    _checkInternalApiRequest(req) {
        if (this._recursionDepth === 0 && this.isSysRequest(req)) {
            throw new HTTPError({
                status: 403,
                body: {
                    type: 'forbidden#sys',
                    title: 'Access to the /sys hierarchy is restricted to system users.'
                }
            });
        }
    }

    request(req, options) {
        if (req.method) {
            req.method = req.method.toLowerCase();
        }
        return this._filteredRequest(req, options);
    }

    _filteredRequest(req, options) {
        this._checkMaxRecursionDepth(req);
        // Make sure we have a sane & uniform request object that doesn't change
        // (at least at the top level) under our feet.
        const childReq = cloneRequest(req);
        const filter = this._recursionDepth === 0 ? this._requestFilters : this._subRequestFilters;
        return this._createFilteredHandler((hyper, childReq) => {
            return hyper._request(childReq, options);
        }, filter)(this, childReq);
    }

    // Process one request
    _request(req, options) {
        // Look up the route in the tree.
        let match = this._priv.router.route(req.uri);
        let handler;
        if (match) {
            req.params = match.params;
            this._checkInternalApiRequest(req);

            // Find a handler.
            const methods = match.value && match.value.methods || {};
            handler = methods[req.method] || methods.all;
            if (!handler &&
                    (req.method === 'head' ||
                        this._rootReq && this._rootReq.method === 'head')) {
                handler = methods && methods.get;
            }
        }

        if (!handler &&
                req.method === 'get' &&
                req.uri.path[req.uri.path.length - 1] === '') {
            // A GET for an URL that ends with /: return a default listing
            const metaPath = req.uri.path.slice(0, -1);
            metaPath.push({ type: 'meta', name: 'apiRoot' });
            let metaMatch = this._priv.router.route(new URI(metaPath, {}, true));
            if (match || metaMatch) {
                if (!metaMatch) {
                    metaMatch = { params: match.params };
                }
                metaMatch.value = metaMatch.value || {};
                metaMatch.value.path = metaMatch.value.path || '_defaultListingHandler';
                match = metaMatch;
                handler = (hyper, req) => this.defaultListingHandler(metaMatch, hyper, req);
            }
        }

        if (handler) {
            // Prepare to call the handler with a child HyperSwitch instance
            const childHyperSwitch = this.makeChild(req, options);
            if (this._recursionDepth === 0) { // We don't want to expose internal API paths
                childHyperSwitch.logger = childHyperSwitch.logger.child({
                    api_path: match.value.path
                });
            }
            const reqHandler = childHyperSwitch._createFilteredHandler(handler, match.filters, {
                path: match.value.path,
                spec: handler.spec,
                specRoot: match.value.specRoot
            });
            // This is a hack. Pure P.try get's executed on this tick, but we wanna
            // wrap it in metrics and access checks and start execution only afterwards.
            // This will go away when filters are completed.
            const reqHandlerPromise = P.resolve()
            .then(() => {
                return reqHandler(childHyperSwitch, req);
            });

            return reqHandlerPromise
            .then((res) => {
                childHyperSwitch.logger.log('trace/hyper/response', {
                    req,
                    res,
                    request_id: childHyperSwitch.reqId
                });

                if (!res) {
                    throw new HTTPError({
                        status: 500,
                        body: {
                            type: 'server_error#empty_response',
                            title: 'Server Error',
                            description: 'Empty response received from a backend service'
                        }
                    });
                } else if (!(res.status >= 100 && res.status < 400) && !(res instanceof Error)) {
                    const err = new HTTPError(res);
                    if (res.body && res.body.stack) {
                        err.stack = res.body.stack;
                    }
                    err.innerBody = res.body && JSON.stringify(res.body).substr(0, 200);
                    err.internalReq = req && {
                        method: req.method,
                        headers: req.headers,
                        query: req.query,
                        body: req.body && JSON.stringify(req.body).substr(0, 200)
                    };
                    throw err;
                } else {
                    return res;
                }
            });
        } else {
            // No handler found.
            throw new HTTPError({
                status: 404,
                body: {
                    type: 'not_found#route',
                    title: 'Not found.',
                    internalURI: req.uri,
                    method: req.method,
                    depth: this._recursionDepth
                }
            });
        }
    }
}

function getDocBasePath(req, spec) {
    if (req.params.domain === req.headers.host.replace(/:[0-9]+$/, '') &&
            spec['x-host-basePath']) {
        // This is a host-based request. Set an appropriate base path.
        return spec['x-host-basePath'];
    }
    return req.uri.toString().replace(/\/$/, '');
}

function filterSpec(spec) {
    let ret = {};
    if (!spec) {
        return spec;
    }
    if (spec.constructor === Object) {
        if (spec['x-hidden']) {
            return null;
        }
        Object.keys(spec).forEach((key) => {
            ret[key] = filterSpec(spec[key]);
            if (ret[key] === null) {
                delete ret[key];
            }
        });
        return ret;
    }
    if (Array.isArray(spec)) {
        return spec.map(filterSpec).filter((x) => x !== null);
    }
    return spec;
}

// A default listing handler for URIs that end in / and don't have any
// handlers associated with it otherwise.
HyperSwitch.prototype.defaultListingHandler = function (match, hyper, req) {
    const rq = req.query;
    if (rq.spec !== undefined &&
            match.value.specRoot && !match.value.specRoot['x-listing']) {
        return P.resolve({
            status: 200,
            body: Object.assign({}, filterSpec(match.value.specRoot), {
                // Set the base path dynamically
                servers: [{ url: getDocBasePath(req, match.value.specRoot) }]
            })
        });
    } else if (rq.path ||
        (match.value.specRoot &&
            !match.value.specRoot['x-listing'] &&
            match.value.specRoot &&
            /\btext\/html\b/.test(req.headers.accept))) {
        // If there's ane query parameters except ?path - redirect to the basePath
        if (Object.keys(req.query).filter((paramName) => {
            return paramName !== 'path';
        }).length) {
            return {
                status: 301,
                headers: {
                    location: `${getDocBasePath(req, match.value.specRoot)}/`
                }
            };
        }
        // Return swagger UI & load spec from /?spec
        if (!req.query.path) {
            req.query.path = '/index.html';
        }
        return swaggerUI(hyper, req, getDocBasePath(req, match.value.specRoot));
    } else if (/\btext\/html\b/.test(req.headers.accept) &&
            match.value.specRoot && match.value.specRoot['x-listing']) {
        // Browser request and above api level
        req.query.path = '/index.html';
        let html = `${'<div id="swagger-ui-container" class="swagger-ui-wrap">' +
                    '<div class="info_title">Wikimedia REST API</div>' +
                    '<h2>APIs:</h2>' +
                    '<div class="info_description markdown"><ul>'}${
            req.params._ls.filter((item) => {
                // TODO: This will filter out everything called `sys`,
                // not only {api:sys} elements
                return item !== 'sys';
            })
                        .map((api) => {
                            return `<li><a href="${encodeURIComponent(api)}/">${api}</a></li>`;
                        }).join('\n')
        }</ul>`;
        html += '<h3>JSON listing</h3><p>To retrieve a regular JSON listing, you can either ' +
            'omit the <code>Accept</code> header, or send one that does not contain ' +
            '<code>text/html</code>.</p></div>';

        return swaggerUI(hyper, req)
        .then((res) => {
            res.body = res.body
                .replace(/window\.swaggerUi\.load\(\);/, '')
                .replace(/<div id="swagger-ui-container" class="swagger-ui-wrap">/, html);
            return res;
        });
    } else {
        // Plain listing
        return P.resolve({
            status: 200,
            body: {
                items: req.params._ls.filter((item) => {
                    // TODO: This will filter out everything called `sys`,
                    // not only {api:sys} elements
                    return item !== 'sys';
                })
            }
        });
    }
};

HyperSwitch.prototype.isSysRequest = (req) => (req.params && req.params.api === 'sys') ||
        // TODO: Remove once params.api is reliable
        (req.uri.path && req.uri.path.length > 1 && req.uri.path[1] === 'sys');

// Deprecated, kept for compat with older versions
HyperSwitch.prototype._isSysRequest = HyperSwitch.prototype.isSysRequest;

HyperSwitch.prototype._createFilteredHandler = function (handler, filters, specInfo) {
    if (!filters || !filters.length) {
        return handler;
    }

    function handlerWrapper(filterIdx, hyper, req) {
        if (filters && filterIdx < filters.length) {
            const filter = filters[filterIdx];
            filterIdx++;

            const next = (hyper, req) => handlerWrapper(filterIdx, hyper, req);

            if (typeof filter === 'function') {
                return filter(hyper, req, next, filter.options, specInfo);
            }

            if (filter.method &&
                filter.method !== req.method &&
                !(filter.method === 'get' && req.method === 'head')) {
                return handlerWrapper(filterIdx, hyper, req);
            }

            return filter.filter(hyper, req, next, filter.options, specInfo);
        } else {
            return P.method(handler)(hyper, req);
        }
    }

    return (hyper, req) => handlerWrapper(0, hyper, req);
};

// Generic parameter massaging:
// * If last parameter is an object, it is expected to be the request object.
// * If the first parameter is a string, it's expected to be the URL.
// * If the second parameter is a String or Buffer, it's expected to be a
//   resource body.
function makeRequest(uri, reqOrBody, method) {
    let req;
    if (uri.constructor === Object) {
        // Fast path
        req = uri;
        req.method = method;
        return req;
    } else if (reqOrBody && reqOrBody.constructor === Object) {
        req = reqOrBody;
        req.uri = uri;
        req.method = method;
    } else {
        req = {
            uri,
            method,
            body: reqOrBody
        };
    }
    return req;
}

// Convenience wrappers
const methods = ['get', 'post', 'put', 'delete', 'head', 'options',
    'trace', 'connect', 'copy', 'move', 'purge', 'search'];
methods.forEach((method) => {
    HyperSwitch.prototype[method] = function (uri, req) {
        return this._filteredRequest(makeRequest(uri, req, method));
    };
});

module.exports = HyperSwitch;

'use strict';

/*
 * HyperSwitch request dispatcher and general shared per-request state namespace
 */

var P = require('bluebird');
var utils = require('./utils');
var HTTPError = require('./exports').HTTPError;
var preq = require('preq');
var swaggerUI = require('./swaggerUI');


/**
 * Create a uniform but shallow request object copy with sane defaults. This
 * keeps code dealing with this request monomorphic (good for perf), and
 * avoids subtle bugs when requests shared between recursive requests are
 * mutated in another control branch. At the very minimum, we are mutating the
 *
 * @param req original request object
 * @returns a shallow copy of a provided requests
 */
function cloneRequest(req) {
    var newReq = Object.assign({}, req);
    newReq.url = undefined;
    newReq.uri = req.uri || req.url || null;
    newReq.method = req.method || 'get';
    newReq.headers = req.headers || {};
    newReq.query = req.query || {};
    newReq.body = req.body !== undefined ? req.body : null;
    newReq.params = req.params || {};
    return newReq;
}

function HyperSwitch(options, req, parOptions) {
    if (options && options.constructor === HyperSwitch) {
        // Child instance
        var par = options;
        parOptions = parOptions || {};
        this.log = parOptions.log || par.log;
        this.metrics = parOptions.metrics || par.metrics;
        this.ratelimiter = parOptions.ratelimiter || par.ratelimiter;
        this.reqId = par.reqId ||
            req && req.headers && req.headers['x-request-id'] ||
            utils.generateRequestId();

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
                'x-client-ip': req.headers['x-client-ip'],
            }
        };
    } else {
        // Brand new instance
        this.log = options.log; // Logging method
        this.metrics = options.metrics;
        this.ratelimiter = options.ratelimiter;
        this.reqId = null;

        // Private
        this._parent = null;
        this._req = null;
        this._recursionDepth = 0;

        options.maxDepth = options.maxDepth || 10;

        // Private state, shared with child instances
        this._priv = {
            options: options,
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
HyperSwitch.prototype.setRequestId = function(req) {

    req.headers = req.headers || {};
    if (req.headers['x-request-id']) {
        return;
    }
    req.headers['x-request-id'] = this.reqId;

};

// Make a child instance
HyperSwitch.prototype.makeChild = function(req, options) {
    return new HyperSwitch(this, req, options);
};

function getDocBasePath(req, spec) {
    if (req.params.domain === req.headers.host.replace(/:[0-9]+$/, '')
            && spec['x-host-basePath']) {
        // This is a host-based request. Set an appropriate base path.
        return spec['x-host-basePath'];
    }
    return req.uri.toString().replace(/\/$/, '');
}
// A default listing handler for URIs that end in / and don't have any
// handlers associated with it otherwise.
HyperSwitch.prototype.defaultListingHandler = function(match, hyper, req) {
    var rq = req.query;
    if (rq.spec !== undefined
            && match.value.specRoot && !match.value.specRoot['x-listing']) {
        return P.resolve({
            status: 200,
            body: Object.assign({}, match.value.specRoot, {
                // Set the base path dynamically
                basePath: getDocBasePath(req, match.value.specRoot)
            })
        });
    } else if (rq.path ||
        (match.value.specRoot
            && !match.value.specRoot['x-listing']
            && match.value.specRoot
            && /\btext\/html\b/.test(req.headers.accept))) {
        // If there's ane query parameters except ?path - redirect to the basePath
        if (Object.keys(req.query).filter(function(paramName) {
                return paramName !== 'path';
            }).length) {
            return {
                status: 301,
                headers: {
                    location: getDocBasePath(req, match.value.specRoot) + '/'
                }
            };
        }
        // Return swagger UI & load spec from /?spec
        if (!req.query.path) {
            req.query.path = '/index.html';
        }
        return swaggerUI(hyper, req);
    } else if (/\btext\/html\b/.test(req.headers.accept)
            && match.value.specRoot && match.value.specRoot['x-listing']) {
        // Browser request and above api level
        req.query.path = '/index.html';
        var html = '<div id="swagger-ui-container" class="swagger-ui-wrap">'
                    + '<div class="info_title">Wikimedia REST API</div>'
                    + '<h2>APIs:</h2>'
                    + '<div class="info_description markdown"><ul>'
                    + req.params._ls.filter(function(item) {
                            // TODO: This will filter out everything called `sys`,
                            // not only {api:sys} elements
                            return item !== 'sys';
                        })
                        .map(function(api) {
                        return '<li><a href="' + encodeURIComponent(api)
                            + '/">' + api + '</a></li>';
                    }).join('\n')
                    + '</ul>';
        html += "<h3>JSON listing</h3><p>To retrieve a regular JSON listing, you can either "
            + "omit the <code>Accept</code> header, or send one that does not contain "
            + "<code>text/html</code>.</p></div>";

        return swaggerUI(hyper, req)
        .then(function(res) {
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
                items: req.params._ls.filter(function(item) {
                    // TODO: This will filter out everything called `sys`,
                    // not only {api:sys} elements
                    return item !== 'sys';
                })
            }
        });
    }
};

HyperSwitch.prototype._isSysRequest = function(req) {
    return ((req.params && req.params.api === 'sys')
        // TODO: Remove once params.api is reliable
            || (req.uri.path && req.uri.path.length > 1 && req.uri.path[1] === 'sys'));
};

/**
 * Checks if the maximum recursion depth has been exceeded by the request.
 * If yes, the 500 error is thrown, othervise this is a no-op
 *
 * @param {Object} req - a current request object
 * @private
 */
HyperSwitch.prototype._checkMaxRecursionDepth = function(req) {
    if (this._recursionDepth > this._priv.options.maxDepth) {
        var parents = [];
        var rb = this._parent;
        while (rb) {
            parents.push(rb._req);
            rb = rb._parent;
        }
        throw new HTTPError({
            status: 500,
            body: {
                type: 'server_error#request_recursion_depth_exceeded',
                title: 'HyperSwitch request recursion depth exceeded.',
                parents: parents,
                depth: this._recursionDepth
            }
        });
    }
};

/**
 * Protects /sys APIs from the direct access.
 *
 * @param {Object} req - an original request
 * @private
 */
HyperSwitch.prototype._checkInternalApiRequest = function(req) {
    if (this._recursionDepth === 0 && this._isSysRequest(req)) {
        throw new HTTPError({
            status: 403,
            body: {
                type: 'forbidden#sys',
                title: 'Access to the /sys hierarchy is restricted to system users.'
            }
        });
    }
};

HyperSwitch.prototype._createFilteredHandler = function(handler, filters, specInfo) {
    if (!filters || !filters.length) {
        return handler;
    }
    var filterIdx = 0;
    return function handlerWrapper(hyper, req) {
        if (filters && filterIdx < filters.length) {
            var filter = filters[filterIdx];
            filterIdx++;

            if (typeof filter === 'function') {
                return filter(hyper, req, handlerWrapper, filter.options, specInfo);
            }

            if (filter.method
                    && filter.method !== req.method
                    && !(filter.method === 'get' && req.method === 'head')) {
                return handlerWrapper(hyper, req);
            }

            return filter.filter(hyper, req, handlerWrapper, filter.options, specInfo);
        } else {
            return P.method(handler)(hyper, req);
        }
    };
};

HyperSwitch.prototype.request = function(req, options) {
    if (req.method) {
        req.method = req.method.toLowerCase();
    }
    return this._filteredRequest(req, options);
};

HyperSwitch.prototype._filteredRequest = function(req, options) {
    this._checkMaxRecursionDepth(req);
    // Make sure we have a sane & uniform request object that doesn't change
    // (at least at the top level) under our feet.
    var childReq = cloneRequest(req);
    return this._createFilteredHandler(function(hyper, childReq) {
        return hyper._request(childReq, options);
    }, this._recursionDepth === 0 ? this._requestFilters : this._subRequestFilters)(this, childReq);
};

// Process one request
HyperSwitch.prototype._request = function(req, options) {
    var self = this;

    // Look up the route in the tree.
    var match = this._priv.router.route(req.uri);
    var handler;
    if (match) {
        req.params = match.params;
        self._checkInternalApiRequest(req);

        // Find a handler.
        var methods = match.value && match.value.methods || {};
        handler = methods[req.method] || methods.all;
        if (!handler
                && (req.method === 'head'
                    || self._rootReq && self._rootReq.method === 'head')) {
            handler = methods && methods.get;
        }

        if (!handler
                && req.method === 'get'
                && req.uri.path[req.uri.path.length - 1] === '') {
            // A GET for an URL that ends with /: return a default listing
            if (!match.value) { match.value = {}; }
            if (!match.value.path) { match.value.path = '_defaultListingHandler'; }
            handler = function(hyper, req) {
                return self.defaultListingHandler(match, hyper, req);
            };
        }
    }

    if (handler) {
        // Prepare to call the handler with a child HyperSwitch instance
        var childHyperSwitch = this.makeChild(req, options);
        var reqHandler = childHyperSwitch._createFilteredHandler(handler, match.filters, {
            path: match.value.path,
            spec: handler.spec
        });
        // This is a hack. Pure P.try get's executed on this tick, but we wanna
        // wrap it in metrics and access checks and start execution only afterwards.
        // This will go away when filters are completed.
        var reqHandlerPromise = P.resolve()
        .then(function() {
            return reqHandler(childHyperSwitch, req);
        });

        return reqHandlerPromise
        .then(function(res) {
            childHyperSwitch.log('trace/hyper/response', {
                req: req,
                res: res,
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
                var err = new HTTPError(res);
                if (res.body && res.body.stack) { err.stack = res.body.stack; }
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
                depth: self._recursionDepth
            }
        });
    }
};

// Generic parameter massaging:
// * If last parameter is an object, it is expected to be the request object.
// * If the first parameter is a string, it's expected to be the URL.
// * If the second parameter is a String or Buffer, it's expected to be a
//   resource body.
function makeRequest(uri, reqOrBody, method) {
    var req;
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
            uri: uri,
            method: method,
            body: reqOrBody
        };
    }
    return req;
}

// Convenience wrappers
var methods = ['get', 'post', 'put', 'delete', 'head', 'options',
    'trace', 'connect', 'copy', 'move', 'purge', 'search'];
methods.forEach(function(method) {
    HyperSwitch.prototype[method] = function(uri, req) {
        return this._filteredRequest(makeRequest(uri, req, method));
    };
});

module.exports = HyperSwitch;

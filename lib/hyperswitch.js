'use strict';

/*
 * HyperSwitch request dispatcher and general shared per-request state namespace
 */

var P = require('bluebird');
var utils = require('./utils');
var HTTPError = require('./exports').HTTPError;
var preq = require('preq');
var swaggerUI = require('./swaggerUI');
var AuthService = require('./auth');


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
    return {
        uri: req.uri || req.url || null,
        method: req.method || 'get',
        headers: req.headers || {},
        query: req.query || {},
        body: req.body !== undefined ? req.body : null,
        params: req.params || {}
    };
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
        this._forwardedHeaders = par._forwardedHeaders || this._rootReq.headers;
        this._authService = par._authService ? new AuthService(par._authService) : null;
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
        this._rootReq = null;
        this._forwardedHeaders = null;
        this._authService = null;
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

// A default listing handler for URIs that end in / and don't have any
// handlers associated with it otherwise.
HyperSwitch.prototype.defaultListingHandler = function(match, hyper, req) {
    var rq = req.query;
    if (rq.spec !== undefined
            && match.value.specRoot && !match.value.specRoot['x-listing']) {
        var spec = Object.assign({}, match.value.specRoot, {
            // Set the base path dynamically
            basePath: req.uri.toString().replace(/\/$/, '')
        });

        if (req.params.domain === req.headers.host.replace(/:[0-9]+$/, '')) {
            // This is a host-based request. Set an appropriate base path.
            spec.basePath = spec['x-host-basePath'] || spec.basePath;
        }

        return P.resolve({
            status: 200,
            body: spec
        });
    } else if (rq.doc !== undefined
            && (match.value.specRoot && !match.value.specRoot['x-listing'] || rq.path)) {
        // Return swagger UI & load spec from /?spec
        if (!req.query.path) {
            req.query.path = '/index.html';
        }
        return swaggerUI(hyper, req);
    } else if (/\btext\/html\b/.test(req.headers.accept)
            && (!match.value.specRoot || match.value.specRoot['x-listing'])) {
        // Browser request and above api level
        req.query.path = '/index.html';
        var html = '<div id="swagger-ui-container" class="swagger-ui-wrap">'
                    + '<div class="info_title">Wikimedia REST API</div>'
                    + '<h2>APIs:</h2>'
                    + '<div class="info_description markdown"><ul>'
                    + req.params._ls.filter(function(item) {
                            return item !== 'sys';
                        })
                        .map(function(api) {
                        return '<li><a href="' + encodeURIComponent(api)
                            + '/?doc">' + api + '</a></li>';
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
                items: req.params._ls
            }
        });
    }
};

// Special handling for external web requests
HyperSwitch.prototype.defaultWebRequestHandler = function(req) {
    // Enforce the usage of UA
    req.headers = req.headers || {};
    req.headers['user-agent'] = req.headers['user-agent'] || this.config.user_agent;
    if (this._authService) {
        this._authService.prepareRequest(this, req);
    }
    this.setRequestId(req);
    this.log('trace/webrequest', {
        req: req,
        request_id: req.headers['x-request-id']
    });
    // Make sure we have a string
    req.uri = '' + req.uri;
    return preq(req)
    .then(function(res) {
        if (res && res.headers) {
            utils.removeHopToHopHeaders(res.headers, true);
        }
        return res;
    });
};

HyperSwitch.prototype._isSysRequest = function(req) {
    return ((req.uri.params && req.uri.params.api === 'sys')
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
                type: 'request_recursion_depth_exceeded',
                title: 'HyperSwitch request recursion depth exceeded.',
                uri: req.uri,
                method: req.method,
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
                type: 'access_denied#sys',
                title: 'Access to the /sys hierarchy is restricted to system users.'
            }
        });
    }
};

HyperSwitch.prototype.request = function(req, options) {
    if (req.method) {
        req.method = req.method.toLowerCase();
    }
    return this._request(req, options);
};

HyperSwitch.prototype._wrapInAccessCheck = function(handlerPromise, match, childReq) {
    var self = this;
    // Don't need to check access restrictions on /sys requests,
    // as these endpoints are internal, so can be accessed only
    // within HyperSwitch. (See HyperSwitch.prototype.request) All required
    // checks should be added and made at the root of the request chain,
    // at /v1 level
    if (!this._isSysRequest(childReq)
            && match.permissions
            && Array.isArray(match.permissions)
            && match.permissions.length) {
        self._authService = self._authService || new AuthService(match.value.specRoot);
        self._authService.addRequirements(match.permissions);
        if (childReq.method === 'get' || childReq.method === 'head') {
            return P.all([
                handlerPromise,
                self._authService.checkPermissions(self, childReq)
            ])
            .then(function(res) { return res[0]; });
        } else {
            return self._authService.checkPermissions(self, childReq)
            .then(function() { return handlerPromise; });
        }
    } else {
        return handlerPromise;
    }
};

// Process one request
HyperSwitch.prototype._request = function(req, options) {
    var self = this;

    // Special handling for https? requests
    var host = req.uri.constructor === String ? req.uri : req.uri.protoHost;
    if (/^https?:\/\//.test(host)) {
        return self.defaultWebRequestHandler(req);
    }

    self._checkMaxRecursionDepth(req);

    // Make sure we have a sane & uniform request object that doesn't change
    // (at least at the top level) under our feet.
    var childReq = cloneRequest(req);

    // Look up the route in the tree.
    var match = this._priv.router.route(childReq.uri);
    var handler;
    if (match) {
        childReq.params = match.params;
        self._checkInternalApiRequest(childReq);

        // Find a handler.
        var methods = match.value && match.value.methods || {};
        handler = methods[childReq.method] || methods.all;
        if (!handler
                && (childReq.method === 'head'
                    || self._rootReq && self._rootReq.method === 'head')) {
            handler = methods && methods.get;
        }

        if (!handler
                && childReq.method === 'get'
                && childReq.uri.path[childReq.uri.path.length - 1] === '') {
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
        var childHyperSwitch = this.makeChild(childReq, options);

        var specInfo = {
            path: match.value.path,
            spec: handler.spec
        };
        var filterIdx = 0;
        var reqHandler = function handlerWrapper(hyper, req) {
            if (filterIdx < match.filters.length) {
                var filter = match.filters[filterIdx];
                filterIdx++;

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

        // This is a hack. Pure P.try get's executed on this tick, but we wanna
        // wrap it in metrics and access checks and start execution only afterwards.
        // This will go away when filters are completed.
        var reqHandlerPromise = P.resolve()
        .then(function() {
            return reqHandler(childHyperSwitch, childReq);
        });

        reqHandlerPromise = reqHandlerPromise
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
                        type: 'empty_response',
                        description: 'Empty response received',
                        req: req
                    }
                });
            } else if (!(res.status >= 100 && res.status < 400) && !(res instanceof Error)) {
                var err = new HTTPError(res);
                if (res.body && res.body.stack) { err.stack = res.body.stack; }
                err.innerBody = res.body;
                err.internalReq = childReq;
                throw err;
            } else {
                return res;
            }
        });

        return childHyperSwitch._wrapInAccessCheck(reqHandlerPromise, match, childReq);
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
        return this._request(makeRequest(uri, req, method));
    };
});

module.exports = HyperSwitch;

'use strict';

var HTTPError = require('../exports').HTTPError;

// Simple per-route rate limiter.

module.exports = function(hyper, req, next, options, specInfo) {
    if (!hyper.ratelimiter) {
        return next(hyper, req);
    }

    var requestClass = hyper._rootReq.headers['x-request-class'];
    if (!options || !options.limits || !options.limits[requestClass]) {
        return next(hyper, req);
    }

    // By default, ignore the domain for limiting purposes.
    var pathKey = hyper.config.service_name + '.'
                    + specInfo.path.replace(/\/[^\/]+\//, '') + '.'
                    + req.method.toUpperCase();

    var key = pathKey + '|' + hyper._rootReq.headers['x-client-ip'];
    if (hyper.ratelimiter.isAboveLimit(key, options.limits[requestClass])) {
        hyper.log('warn/ratelimit/' + pathKey, {
            key: key,
            rate_limit_per_second: options.limits[requestClass],
            message: 'Rate limit exceeded'
        });
        if (!options.log_only) {
            throw new HTTPError({
                status: 429,
                body: {
                    type: 'request_rate_exceeded',
                    title: 'HyperSwitch request rate limit exceeded',
                    key: key,
                    rate_limit_per_second: options.limits[requestClass],
                }
            });
        }
    }
    return next(hyper, req);
};

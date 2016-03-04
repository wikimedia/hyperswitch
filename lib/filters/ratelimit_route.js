'use strict';

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
        // TODO: Actually throw an HTTPError once we have verified limits to
        // work well.
        hyper.log('warn/ratelimit/' + pathKey, {
            key: key,
            limit: options.limits[requestClass],
            message: 'Rate limit exceeded'
        });
    }
    return next(hyper, req);
};

"use strict";

var utils = require('../utils');
var HTTPError = require('../exports').HTTPError;

module.exports = function(hyper, req, next, options) {
    var errorMessage = options.error_message
        || 'This client is not allowed to use the endpoint';
    // Skip a check on requests made by HyperSwitch during startup
    if (hyper._rootReq.uri !== '#internal-startup') {
        Object.keys(options.whitelist).forEach(function(headerName) {
            options._cache[headerName] = options._cache[headerName]
                || utils.constructRegex(options.whitelist[headerName]);
            var headerValue = req.headers && req.headers[headerName]
                    || hyper._rootReq.headers && hyper._rootReq.headers[headerName];
            if (!options._cache[headerName].test(headerValue)) {
                throw new HTTPError({
                    status: options.error_status || 403,
                    body: {
                        type: 'forbidden',
                        title: 'Access to resource denied',
                        detail: errorMessage
                    }
                });
            }
        });
    }
    return next(hyper, req);
};
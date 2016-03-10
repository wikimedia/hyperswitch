"use strict";

var HTTPError = require('../exports').HTTPError;

/**
 * From a list of uri Regex and values, constructs a regex to check if the
 * request URI is in the white-list.
 */
var CACHE = new Map();
function constructInternalRequestRegex(variants) {
    if (CACHE.has(variants)) {
        return CACHE.get(variants);
    }
    var regex = (variants || []).map(function(regexString) {
        if (/^\/.+\/$/.test(regexString)) {
            return '(:?' + regexString.substring(1, regexString.length - 1) + ')';
        } else {
            // Instead of comparing strings
            return '(:?^'
                + regexString.replace(/[\-\[\]\/\{}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&")
                + '$)';
        }
    }).join('|');
    regex = regex && regex.length > 0 ? new RegExp(regex) : undefined;
    CACHE.set(variants, regex);
    return regex;
}

module.exports = function(hyper, req, next, options) {
    var errorMessage = options.error_message
        || 'This client is not allowed to use the endpoint';
    // Skip a check on requests made by HyperSwitch during startup
    if (hyper._rootReq.uri !== '#internal-startup') {
        Object.keys(options.whitelist).forEach(function(headerName) {
            var valueRegex = constructInternalRequestRegex(options.whitelist[headerName]);
            var headerValue = req.headers && req.headers[headerName]
                    || hyper._rootReq.headers && hyper._rootReq.headers[headerName];
            if (!valueRegex.test(headerValue)) {
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
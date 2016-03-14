"use strict";

var preq = require('preq');
var utils = require('../utils');
var regexUtils = require('regexp-utils');

module.exports = function(hyper, req, next, options) {
    options = options || {};
    var host = req.uri.constructor === String ? req.uri : req.uri.protoHost;
    var match;
    if (options.allow) {
        if (!options._cache.allowSwitch) {
            options.allow.forEach(function(item) {
                item.pattern = utils.constructRegex([ item.pattern ]);
            });
            options._cache.allowSwitch = regexUtils.makeRegExpSwitch(options.allow);
        }
        match = options._cache.allowSwitch(host);
    } else {
        match = /^https?:\/\//.test(host) ? { matcher: { forward_headers: false } } : null;
    }

    if (!match) {
        return next(hyper, req);
    }

    // Enforce the usage of UA
    req.headers = req.headers || {};
    req.headers['user-agent'] = req.headers['user-agent'] || hyper.config.user_agent;
    hyper.setRequestId(req);
    hyper.log('trace/webrequest', {
        req: req,
        request_id: req.headers['x-request-id']
    });
    // Make sure we have a string
    req.uri = '' + req.uri;

    if (match.matcher.forward_headers) {
        if (hyper.ctx.headers) {
            req.headers = req.headers || {};
            Object.keys(hyper.ctx.headers).forEach(function(headerName) {
                req.headers[headerName] = req.headers[headerName] || hyper.ctx.headers[headerName];
            });
        }
    }

    return preq(req)
    .then(function(res) {
        if (res && res.headers) {
            utils.removeHopToHopHeaders(res.headers, true);
        }
        return res;
    });
};

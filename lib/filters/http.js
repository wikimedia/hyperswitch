"use strict";

const preq = require('preq');
const utils = require('../utils');
const regexUtils = require('regexp-utils');

module.exports = (hyper, req, next, options) => {
    options = options || {};
    const host = req.uri.constructor === String ? req.uri : req.uri.protoHost;
    let match;
    if (options.allow) {
        if (!options._cache.allowSwitch) {
            options.allow.forEach((item) => {
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

    // Make sure we have a string
    req.uri = `${req.uri}`;
    // The request ID is not personally identifyable information without
    // access to logstash, so always set / forward it.
    hyper.setRequestId(req);

    hyper.logger.log('trace/webrequest', {
        request_id: req.headers['x-request-id'],
        req,
    });

    const forwardHeaders = match.matcher.forward_headers;

    // General precedence:
    // 1) req.headers
    // 2) hyper.ctx.headers (default: user-agent, x-forwarded-for &
    //    x-client-ip)
    function forwardHeader(name, defaultVal) {
        if (forwardHeaders === true || forwardHeaders[name]) {
            let newVal = req.headers[name] || defaultVal;
            if (newVal === undefined) {
                newVal = hyper.ctx.headers[name];
            }
            if (newVal === undefined && name === 'user-agent') {
                newVal = hyper.config.user_agent;
            }

            if (newVal) {
                req.headers[name] = newVal;
            }
        }
    }

    if (forwardHeaders) {
        // All headers but the random request ID are potentially personally
        // identifyable information, so only forward it to explicitly trusted
        // services.

        if (forwardHeaders === true) {
            Object.keys(hyper.ctx.headers).forEach((headerName) => {
                forwardHeader(headerName);
            });
        } else {
            // forwardHeaders is an object indicating which headers to
            // forward.
            Object.keys(forwardHeaders).forEach((headerName) => {
                forwardHeader(headerName);
            });
        }
    }

    return preq(req)
    .then((res) => {
        if (res && res.headers) {
            utils.removeHopToHopHeaders(res.headers, true);
        }
        return res;
    });
};

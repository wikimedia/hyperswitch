"use strict";


/*
 * Static utility methods
 */

var uuid = require('cassandra-uuid').TimeUuid;

var utils = {};

/**
 * Generates a new request ID
 * @returns {String} v1 UUID for the request
 */
utils.generateRequestId = function() {
    return uuid.now().toString();
};

/**
 * Removes Hop-To-Hop headers that might be
 * proxied from a backend service
 *
 * @param {Object} rh response headers
 * @param {boolean} removeContentEncoding whether to remove the `content-encoding` header
 */
utils.removeHopToHopHeaders = function removeHopToHopHeaders(rh, removeContentEncoding) {
    var headers = [
        'connection',
        'keep-alive',
        'public',
        'proxy-authenticate',
        'transfer-encoding',
        'content-length'
    ];
    if (removeContentEncoding) {
        headers.push('content-encoding');
    }
    headers.forEach(function(headerName) {
        // Need to delete properties and not set to undefined
        // because node passes 'undefined' to client.
        if (rh[headerName]) {
            delete rh[headerName];
        }
    });
};

/**
 * From a list of uri Regex and values, constructs a regex to check if the
 * request URI is in the white-list.
 */
utils.constructRegex = function(variants) {
    var regex = (variants || []).map(function(regexString) {
        regexString = regexString.trim();
        if (/^\/.+\/$/.test(regexString)) {
            return '(:?' + regexString.substring(1, regexString.length - 1) + ')';
        } else {
            // Instead of comparing strings
            return '(:?^'
            + regexString.replace(/[\-\[\]\/\{}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&")
            + ')';
        }
    }).join('|');
    regex = regex && regex.length > 0 ? new RegExp(regex) : undefined;
    return regex;
};

module.exports = utils;

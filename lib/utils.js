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

module.exports = utils;

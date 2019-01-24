'use strict';

/*
 * Static utility methods
 */

const uuid = require('cassandra-uuid').TimeUuid;

const utils = {};

/**
 * Generates a new request ID
 * @return {string} v1 UUID for the request
 */
utils.generateRequestId = () => uuid.now().toString();

/**
 * Removes Hop-To-Hop headers that might be
 * proxied from a backend service
 * @param {Object} rh response headers
 * @param {boolean} removeContentEncoding whether to remove the `content-encoding` header
 */
utils.removeHopToHopHeaders = function removeHopToHopHeaders(rh, removeContentEncoding) {
    const headers = [
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
    headers.forEach((headerName) => {
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
 * @param   {Array} variants
 * @return {string}
 */
utils.constructRegex = (variants) => {
    let regex = (variants || []).map((regexString) => {
        regexString = regexString.trim();
        if (/^\/.+\/$/.test(regexString)) {
            return `(:?${regexString.substring(1, regexString.length - 1)})`;
        } else {
            // Instead of comparing strings
            return `(:?^${regexString.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')})`;
        }
    }).join('|');
    regex = regex && regex.length > 0 ? new RegExp(regex) : undefined;
    return regex;
};

/**
 * In case a logger is not provided, use this class as a replacement
 * to avoid TypeErrors and undefined logger instances. \
 *
 * Added for backwards compatibility, since not all the clients are ready to
 * undefined logger instance.
 */
class NullLogger {
    log() {
        // no-op
    }
    child() {
        return new NullLogger();
    }
    close() {
        // no-op
    }
}
utils.nullLogger = new NullLogger();

module.exports = utils;

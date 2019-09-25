'use strict';

/*
 * Static utility methods
 */

const uuidv1 = require('uuid/v1');

const utils = {};

/**
 * Generates a new request ID
 * @return {string} v1 UUID for the request
 */
utils.generateRequestId = () => uuidv1();

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

/**
 * Deep merge two objects.
 * @param {Object} target
 * @param {Object} ...sources
 * @return {Object}
 */
utils.mergeDeep = (target, ...sources) => {
    const isObject = (item) => {
        return (item && typeof item === 'object' && !Array.isArray(item));
    };

    if (!sources || !sources.length || !target || !isObject(target)) {
        return target;
    }

    sources.forEach((source) => {
        if (isObject(target) && isObject(source)) {
            Object.keys(source).forEach((key) => {
                if (isObject(source[key])) {
                    if (!target[key]) {
                        target[key] = {};
                    }
                    utils.mergeDeep(target[key], source[key]);
                } else if (isObject(target[key]) && !isObject(source[key]))  {
                    throw new Error("Only objects of the same 'shape' are supported");
                } else {
                    target[key] = source[key];
                }
            });
        }
    });
    return target;
};

utils.exportGlobal = (global) => {
    if (!global || ['string', 'number', 'boolean'].includes(typeof global)) {
        return global;
    }
    if (Array.isArray(global)) {
        return global.map((x) => utils.exportGlobal(x));
    }
    if (global.constructor === Object) {
        // because the logger appears at various positions in the globals, we need
        // to filter it out as it depends on its position how it gets stringified
        // TODO: figure out how to get rid of the logger altogether, as it really
        // shouldn't be part of the globals object
        const keys = Object.keys(global).filter((item) => item !== 'logger' &&
            !!global[item] && typeof global[item] !== 'function');
        const ret = {};
        keys.forEach((x) => {
            ret[x] = utils.exportGlobal(global[x]);
        });
        return ret;
    }
    return global;
};

module.exports = utils;

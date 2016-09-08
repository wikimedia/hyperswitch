"use strict";

var util = require('util');
var swaggerRouter = require('swagger-router');
var yaml = require('js-yaml');
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;

var exports = {};

function Lifecycle() {
    EventEmitter.call(this);
    this._initialized = false;
}
util.inherits(Lifecycle, EventEmitter);

/**
 * Lazily sets up forwarding of the application-lifecycle events
 * to the exported object. Only called if the client subscribed to
 * some events.
 *
 * @private
 */
Lifecycle.prototype._setup = function() {
    var self = this;
    // The server will certainly be initialized by now
    var server = require('./server').server;
    server.on('close', function() { self.emit('close'); });
};
[
    'addListener',
    'on',
    'once',
    'prependListener',
    'prependOnceListener'
].forEach(function(funcName) {
    Lifecycle.prototype[funcName] = function(eventName, listener) {
        if (!this._initialized) {
            this._setup();
        }
        EventEmitter.prototype[funcName].call(this, eventName, listener);
    };
});
exports.lifecycle = new Lifecycle();

/*
 * Error instance wrapping HTTP error responses
 *
 * Has the same properties as the original response.
 */
function HTTPError(response) {
    Error.call(this);
    Error.captureStackTrace(this, HTTPError);
    this.name = this.constructor.name;
    this.message = response.status + '';
    if (response.body && response.body.type) {
        this.message += ': ' + response.body.type;
    }
    Object.assign(this, response);
}
util.inherits(HTTPError, Error);
exports.HTTPError = HTTPError;

exports.misc = {};

exports.utils = {};

exports.utils.loadSpec = function(path) {
    return yaml.safeLoad(fs.readFileSync(path));
};

exports.URI = swaggerRouter.URI;
exports.Template = swaggerRouter.Template;

module.exports = exports;

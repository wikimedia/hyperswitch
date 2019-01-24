'use strict';

const swaggerRouter = require('swagger-router');
const yaml = require('js-yaml');
const fs = require('fs');
const EventEmitter = require('events').EventEmitter;

const exporting = {};

class Lifecycle extends EventEmitter {
    constructor() {
        super();
        this._initialized = false;
    }

    /**
     * Lazily sets up forwarding of the application-lifecycle events
     * to the exported object. Only called if the client subscribed to
     * some events.
     * @private
     */
    _setup() {
        // The server will certainly be initialized by now
        const server = require('./server').server;
        server.on('close', () => this.emit('close'));
    }
}

[
    'addListener',
    'on',
    'once',
    'prependListener',
    'prependOnceListener'
].forEach((funcName) => {
    Lifecycle.prototype[funcName] = function (eventName, listener) {
        if (!this._initialized) {
            this._setup();
        }
        EventEmitter.prototype[funcName].call(this, eventName, listener);
    };
});
exporting.lifecycle = new Lifecycle();

/*
 * Error instance wrapping HTTP error responses
 * Has the same properties as the original response.
 */
class HTTPError extends Error {
    constructor(response) {
        super();
        Error.captureStackTrace(this, HTTPError);
        this.name = this.constructor.name;
        this.message = `${response.status}`;
        if (response.body && response.body.type) {
            this.message += `: ${response.body.type}`;
        }
        Object.assign(this, response);
    }

    /**
     * Factory function wrapping generic JS Error to HTTPError
     * @param {Error} e original error
     * @return {HTTPError}
     */
    static fromError(e) {
        if (e && e.name === 'HTTPError') {
            return e;
        }
        const originalError = e;
        const stack = e && e.stack;
        e = new HTTPError({
            status: 500,
            body: {
                type: 'internal_error',
                description: `${e}`
                // Probably better to keep this private for now
                // stack: e.stack
            }
        });
        // Log this internally
        e.stack = stack;
        e.innerError = originalError;
        return e;
    }
}

exporting.HTTPError = HTTPError;

exporting.misc = {};

exporting.utils = {};

exporting.utils.loadSpec = (path) => yaml.safeLoad(fs.readFileSync(path));

exporting.URI = swaggerRouter.URI;
exporting.Template = swaggerRouter.Template;
exporting.Router = require('./router');

module.exports = exporting;

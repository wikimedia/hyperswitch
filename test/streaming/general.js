'use strict';

var assert = require('../utils/assert.js');
var Server = require('../utils/server.js');
var preq = require('preq');

describe('Handler Template', () => {
    var server = new Server('test/streaming/test_config.yaml');
    before(() => { return server.start(); });

    it('Basic streaming',() => {
        return preq.get({ uri: server.hostPort + '/test/hello' })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-type'], 'text/html');
            assert.deepEqual(res.body, 'hello');
        });
    });

    it('Buffer streaming',() => {
        return preq.get({ uri: server.hostPort + '/test/buffer' })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-type'], 'text/html');
            assert.deepEqual(res.body, 'hello');
        });
    });

    it('Buffer streaming, no compression',() => {
        return preq.get({
            uri: server.hostPort + '/test/buffer',
            gzip: false
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-type'], 'text/html');
            assert.deepEqual(res.body, 'hello');
        });
    });

    it('Multi-chunk streaming',() => {
        return preq.get({ uri: server.hostPort + '/test/chunks' })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-type'], 'text/html');
            if (!/^0123456.*99$/.test(res.body)) {
                throw new Error('Expected the body to match /^0123456.*99$/');
            }
        });
    });

    after(() => { return server.stop(); });
});

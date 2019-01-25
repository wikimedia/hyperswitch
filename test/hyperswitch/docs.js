"use strict";

var assert = require('../utils/assert.js');
var Server = require('../utils/server.js');
var preq   = require('preq');
var P      = require('bluebird');

describe('Documentation handling',() => {
    var server = new Server('test/hyperswitch/docs_config.yaml');

    before(() => { return server.start(); });

    it('should list APIs using the generic listing handler',() => {
        return preq.get({
            uri: server.hostPort + '/'
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'application/json');
            assert.deepEqual(res.body, {
                items: [ 'v1' ]
            });
        });
    });

    it('should retrieve the spec',() => {
        return preq.get({
            uri: server.hostPort + '/v1/?spec'
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'application/json');
            assert.deepEqual(res.body.swagger, '2.0');
        });
    });

    it('should retrieve the swagger-ui main page',() => {
        return preq.get({
            uri: server.hostPort + '/v1/',
            headers: {
                accept: 'text/html'
            }
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'text/html');
            assert.deepEqual(/<html/.exec(res.body)[0], '<html');
        });
    });

    it('should not retrieve the swagger-ui main page further down the hierarchy',() => {
        return preq.get({
            uri: server.hostPort + '/v1/test/',
            headers: {
                accept: 'text/html'
            }
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'application/json');
        });
    });

    it('should retrieve all dependencies of the swagger-ui main page',() => {
        return preq.get({
            uri: server.hostPort + '/v1/',
            headers: {
                accept: 'text/html'
            }
        })
        .then((res) => {
            var assertions = [];
            var linkRegex = /<link\s[^>]*href=["']([^"']+)["']/g;
            var scriptRegex =  /<script\s[^>]*src=["']([^"']+)["']/g;
            var match;
            while (match = linkRegex.exec(res.body)) {
                assertions.push(match[1]);
            }
            while (match = scriptRegex.exec(res.body)) {
                assertions.push(match[1]);
            }
            return P.all(assertions.map((path) => {
                return preq.get({ uri: server.hostPort + '/' + path })
                .then((res) => {
                    assert.deepEqual(res.status, 200);
                });
            }));
        });
    });

    it('should retrieve API listing in html',() => {
        return preq.get({
            uri: server.hostPort + '/',
            headers: {
                accept: 'text/html'
            }
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'text/html');
            assert.deepEqual(/<html/.exec(res.body)[0], '<html');
        });
    });

    it('should throw error for static serve', () => {
        return preq.get({
            uri: server.hostPort + '/v1/?path=/this_is_no_a_path',
            headers: {
                accept: 'text/html'
            }
        })
        .then(() => {
            throw new Error('Error should be thrown');
        }, (e) => {
            assert.deepEqual(e.status, 404);
        });
    });

    it('should disallow unsecure relative paths for static serve', () => {
        return preq.get({
            uri: server.hostPort + '/v1/?path=../../../Test',
            headers: {
                accept: 'text/html'
            }
        })
        .then(() => {
            throw new Error('Error should be thrown');
        }, (e) => {
            assert.deepEqual(e.status, 500);
            assert.deepEqual(e.body.detail, 'Error: Invalid path.');
        });
    });

    it('should not list sys api',  () => {
        return preq.get({
            uri: server.hostPort + '/'
        })
        .then((res) => {
            assert.deepEqual(res.body, {
                items: [ 'v1' ]
            });
        });
    });

    it('should not allow doc requests to sys', () => {
        return preq.get({
            uri: server.hostPort + '/sys/',
            headers: {
                accept: 'text/html'
            }
        })
        .then(() => {
            throw new Error('Error should be thrown');
        }, (e) => {
            assert.deepEqual(e.status, 403);
        });
    });

    after(() => { return server.stop(); });
});

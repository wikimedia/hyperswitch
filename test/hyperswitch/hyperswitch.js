'use strict';

var assert = require('../utils/assert.js');
var Server = require('../utils/server.js');
var preq   = require('preq');

var main = require('../../lib/server');

// mocha defines to avoid JSHint breakage
/* global describe, it, before, beforeEach, after, afterEach */

describe('HyperSwitch context', function() {
    var server = new Server('test/hyperswitch/test_config.yaml');

    before(function() {
        return server.start();
    });

    it('Does not allow infinite recursion', function () {
        return preq.get({ uri: server.hostPort + '/service/recursive/TestTitle' })
        .then(function () {
            throw new Error('Must not allow infinite recursion')
        }, function(e) {
            assert.deepEqual(e.status, 500);
            assert.deepEqual(e.body.title, 'HyperSwitch request recursion depth exceeded.');
        });
    });

    it('Supports head request', function () {
        return preq.head({ uri: server.hostPort + '/service/head/TestTitle' })
        .then(function (res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers.test, 'test');
            assert.deepEqual(res.body, new Buffer(''));
        });
    });

    it('Automatically hooks validation', function () {
        return preq.get({ uri: server.hostPort + '/service/validation/abcde' })
        .then(function () {
            throw new Error('Should throw a validation error');
        }, function(e) {
            assert.deepEqual(e.status, 400);
            assert.deepEqual(e.body.title, 'Invalid parameters');
        });
    });


    it('Works fine if validation is passed', function () {
        return preq.get({ uri: server.hostPort + '/service/validation/1' })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers.test, 'test');
        });
    });

    it('Provides API listings', function () {
        return preq.get({ uri: server.hostPort + '/service/' })
        .then(function (res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-type'], 'application/json');
            assert.notDeepEqual(res.body.items.indexOf('head'), -1);
            assert.notDeepEqual(res.body.items.indexOf('recursive'), -1);
            assert.notDeepEqual(res.body.items.indexOf('validation'), -1);
        });
    });

    it('Throws 404 when no handler is found', function () {
        return preq.get({ uri: server.hostPort + '/this_path_does_not_exist/' })
        .then(function () {
            throw new Error('404 should be thrown');
        }, function(e) {
            assert.deepEqual(e.status, 404);
            assert.deepEqual(e.headers['content-type'], 'application/problem+json');
            assert.deepEqual(e.body, {
                type: 'https://restbase.org/errors/not_found#route',
                title: 'Not found.',
                method: 'get',
                uri: '/this_path_does_not_exist/'
            });
        });
    });

    it('Throws error when bad response is provided', function () {
        return preq.get({ uri: server.hostPort + '/service/no_response' })
        .then(function () {
            throw new Error('400 should be thrown');
        }, function(e) {
            assert.deepEqual(e.status, 400);
            assert.deepEqual(e.headers['content-type'], 'application/problem+json');
            assert.deepEqual(e.body.uri, '/service/no_response');
        });
    });

    it('Gzips content and provides correct content-length', function () {
        return preq.get({
            uri: server.hostPort + '/service/gzip_response',
            headers: {
                'accept-encoding': 'gzip'
            }
        })
        .then(function (res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-length'], undefined);
        });
    });

    it('parses JSON content', function() {
        // First try invalid JSON body
        return preq.post({
            uri: server.hostPort + '/service/json_body',
            headers: {
                'content-type': 'application/json'
            },
            body: '{"field": "wrong'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            // Now try passing a valid json
            return preq.post({
                uri: server.hostPort + '/service/json_body',
                headers: {
                    'content-type': 'application/json'
                },
                body: {
                    field: 'value'
                }
            });
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.body, { result: 'value' });
        });
    });

    var simpleSpec = {
        paths: {
            '/test': {
                get: {
                    'x-request-handler': [
                        {
                            returnResult: {
                                return: {
                                    status: 200,
                                    body: 'TEST'
                                }
                            }
                        }
                    ]
                }
            }
        }
    };

    it('does not explode if no logger and metrics provided', function() {
        var options = {
            appBasePath: __dirname + '/../../',
            config: {
                salt: 'test',
                port: 12346,
                spec: simpleSpec
            }
        };
        return main(options)
        .then(function(server) {
            return preq.get({
                uri: 'http://localhost:12346/test'
            })
            .then(function(res) {
                assert.deepEqual(res.status, 200);
                assert.deepEqual(res.body, 'TEST');
                return preq.get({
                    uri: 'http://localhost:12346/not_found'
                })
                .then(function() {
                    throw new Error('Error should be thrown');
                }, function(e) {
                    assert.deepEqual(e.status, 404);
                });
            })
            .finally(function() {
                server.close();
            });
        });
    });

    it('requires salt in the config', function() {
        try {
            main({
                appBasePath: __dirname + '/../../',
                config: {
                    port: 12346,
                    spec: simpleSpec
                }
            });
            throw new Error('Should throw error on invalid salt');
        } catch (e) {
            assert.deepEqual(e.message,
                'Missing or invalid `salt` option in HyperSwitch config. Expected a string.')
        }

        try {
            main({
                appBasePath: __dirname + '/../../',
                config: {
                    salt: 1,
                    port: 12346,
                    spec: simpleSpec
                }
            });
            throw new Error('Should throw error on invalid salt');
        } catch (e) {
            assert.deepEqual(e.message,
            'Missing or invalid `salt` option in HyperSwitch config. Expected a string.')
        }
    });

    it('Should strip out hop-to-hop headers', function() {
        return preq.get({
            uri: server.hostPort + '/service/hop_to_hop'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers.hasOwnProperty('transfer-encoding'), false);
            assert.deepEqual(res.headers.hasOwnProperty('public'), false);
            assert.deepEqual(res.headers.hasOwnProperty('content-encoding'), false);
        });
    });

    after(function() { return server.stop(); });
});
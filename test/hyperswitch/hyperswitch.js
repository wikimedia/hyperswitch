'use strict';

var assert = require('../utils/assert.js');
var Server = require('../utils/server.js');
var preq   = require('preq');
var nock   = require('nock');

var main = require('../../lib/server');


describe('HyperSwitch context',() => {
    var server = new Server('test/hyperswitch/test_config.yaml');

    before(() => {
        return server.start();
    });

    it('Does not allow infinite recursion',() => {
        return preq.get({ uri: server.hostPort + '/service/recursive/TestTitle' })
        .then(function () {
            throw new Error('Must not allow infinite recursion')
        }, (e) => {
            assert.deepEqual(e.status, 500);
            assert.deepEqual(e.body.title, 'HyperSwitch request recursion depth exceeded.');
        });
    });

    it('Supports head request',() => {
        return preq.head({ uri: server.hostPort + '/service/head/TestTitle' })
        .then(function (res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers.test, 'test');
            assert.deepEqual(res.body, Buffer.from(''));
        });
    });

    it('Automatically hooks validation',() => {
        return preq.get({ uri: server.hostPort + '/service/validation/abcde' })
        .then(function () {
            throw new Error('Should throw a validation error');
        }, (e) => {
            assert.deepEqual(e.status, 400);
            assert.deepEqual(e.body.title, 'Invalid parameters');
        });
    });


    it('Works fine if validation is passed',() => {
        return preq.get({ uri: server.hostPort + '/service/validation/1' })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers.test, 'test');
        });
    });

    it('Provides API listings',() => {
        return preq.get({ uri: server.hostPort + '/service/' })
        .then(function (res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-type'], 'application/json');
            assert.notDeepEqual(res.body.items.indexOf('head'), -1);
            assert.notDeepEqual(res.body.items.indexOf('recursive'), -1);
            assert.notDeepEqual(res.body.items.indexOf('validation'), -1);
        });
    });

    it('Throws 404 when no handler is found',() => {
        return preq.get({ uri: server.hostPort + '/this_path_does_not_exist/' })
        .then(function () {
            throw new Error('404 should be thrown');
        }, (e) => {
            assert.deepEqual(e.status, 404);
            assert.deepEqual(e.headers['content-type'], 'application/problem+json');
            assert.deepEqual(e.body, {
                type: 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found#route',
                title: 'Not found.',
                method: 'get',
                uri: '/this_path_does_not_exist/',
                internalURI: 'http://localhost:12345/this_path_does_not_exist/',
                internalMethod: 'get'
            });
        });
    });

    it('Throws error when bad response is provided',() => {
        return preq.get({ uri: server.hostPort + '/service/no_response' })
        .then(function () {
            throw new Error('400 should be thrown');
        }, (e) => {
            assert.deepEqual(e.status, 400);
            assert.deepEqual(e.headers['content-type'], 'application/problem+json');
            assert.deepEqual(e.body.uri, '/service/no_response');
        });
    });

    it('Gzips content and provides correct content-length',() => {
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

    it('parses JSON content',() => {
        // First try invalid JSON body
        return preq.post({
            uri: server.hostPort + '/service/json_body',
            headers: {
                'content-type': 'application/json'
            },
            body: '{"field": "wrong'
        })
        .then((res) => {
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
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.body, { result: 'value' });
        });
    });

    it('is OK with empty POST',() => {
        return preq.post({
            uri: server.hostPort + '/service/empty_body',
            headers: {
                'content-type': 'application/json'
            }
        })
        .then(function (res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.body, {result: 'value'});
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

    it('does not explode if no logger and metrics provided',() => {
        var options = {
            appBasePath: __dirname + '/../../',
            config: {
                salt: 'test',
                port: 12346,
                spec: simpleSpec
            }
        };
        return main(options)
        .then((server) => {
            return preq.get({
                uri: 'http://localhost:12346/test'
            })
            .then((res) => {
                assert.deepEqual(res.status, 200);
                assert.deepEqual(res.body, 'TEST');
                return preq.get({
                    uri: 'http://localhost:12346/not_found'
                })
                .then(() => {
                    throw new Error('Error should be thrown');
                }, (e) => {
                    assert.deepEqual(e.status, 404);
                });
            })
            .finally(() => {
                server.close();
            });
        });
    });

    it('Should strip out hop-to-hop headers',() => {
        return preq.get({
            uri: server.hostPort + '/service/hop_to_hop/en.wikipedia.org'
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers.hasOwnProperty('public'), false);
            assert.deepEqual(res.headers.hasOwnProperty('content-encoding'), false);
        });
    });

    it('Should retrieve the if multi-api is not used',() => {
        return preq.get({
            uri: server.hostPort + '/?spec'
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'application/json');
            assert.deepEqual(res.body.openapi, '3.0.1');
        });
    });

    it('Should not gzip already gzipped content',() => {
        return preq.get({
            uri: server.hostPort + '/service/module/gzip'
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.body.toString(), 'TEST');
        });
    });

    it('Should unzip content if it is not accepted', () => {
        return preq.get({
            uri: server.hostPort + '/service/module/gzip',
            headers: {
                'accept-encoding': 'identity'
            },
            gzip: false
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers.hasOwnProperty('content-encoding'), false);
            assert.deepEqual(res.body.toString(), 'TEST');
        });
    });

    it('Should get remote content with URI', () => {
        return preq.get({
            uri: server.hostPort + '/service/module/remote'
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
        });
    });

    it('Should only pass UA and x-client-ip if header forwarding is `true`',() => {
        var api = nock('https://trusted.service', {
            reqheaders: {
                'user-agent': 'test_user_agent',
                'x-client-ip': '127.0.0.1',
            },
            badheaders: ['cookie', 'x-forwarded-for'],
        })
        .get('/wiki/Main_Page').reply(200, {});

        return preq.get({
            uri: server.hostPort + '/service/hop_to_hop/trusted.service',
            headers: {
                'user-agent': 'test_user_agent',
                'x-client-ip': '127.0.0.1',
                'x-forwarded-for': 'also secret',
                cookie: 'very secret',
            }
        })
        .then(() => {
            api.done();
        })
        .finally(() => {
            nock.cleanAll();
        });
    });

    it('Should pass UA, but not other sensitive headers',() => {
        var api = nock('https://en.wikipedia.org', {
            reqheaders: {
                'user-agent': 'test_user_agent',
            },
            badheaders: ['x-client-ip', 'cookie', 'x-forwarded-for'],
        })
        .get('/wiki/Main_Page').reply(200, {});

        return preq.get({
            uri: server.hostPort + '/service/hop_to_hop/en.wikipedia.org',
            headers: {
                'user-agent': 'test_user_agent',
                'x-client-ip': 'secret',
                'x-forwarded-for': 'also secret',
                cookie: 'very secret',
            }
        })
        .then(() => {
            api.done();
        })
        .finally(() => {
            nock.cleanAll();
        });
    });

    after(() => { return server.stop(); });
});

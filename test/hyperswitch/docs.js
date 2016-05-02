"use strict";

var assert = require('../utils/assert.js');
var Server = require('../utils/server.js');
var preq   = require('preq');
var P      = require('bluebird');

describe('Documentation handling', function() {
    var server = new Server('test/hyperswitch/docs_config.yaml');

    before(function() { return server.start(); });

    it('should list APIs using the generic listing handler', function() {
        return preq.get({
            uri: server.hostPort + '/'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'application/json');
            assert.deepEqual(res.body, {
                items: [ 'v1' ]
            });
        });
    });

    it('should retrieve the spec', function() {
        return preq.get({
            uri: server.hostPort + '/v1/?spec'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'application/json');
            assert.deepEqual(res.body.swagger, '2.0');
        });
    });

    it('should retrieve the swagger-ui main page', function() {
        return preq.get({
            uri: server.hostPort + '/v1/?doc'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'text/html');
            assert.deepEqual(/<html/.exec(res.body)[0], '<html');
        })
            .catch(function (e) {
                console.log(e);
            });
    });

    it('should retrieve all dependencies of the swagger-ui main page', function() {
        return preq.get({ uri: server.hostPort + '/v1/?doc' })
        .then(function(res) {
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
            return P.all(assertions.map(function(path) {
                return preq.get({ uri: server.hostPort + '/' + path })
                .then(function(res) {
                    assert.deepEqual(res.status, 200);
                });
            }));
        });
    });

    it('should retrieve API listing in html', function() {
        return preq.get({
            uri: server.hostPort + '/',
            headers: {
                accept: 'text/html'
            }
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.contentType(res, 'text/html');
            assert.deepEqual(/<html/.exec(res.body)[0], '<html');
        });
    });

    it('should throw error for static serve', function() {
        return preq.get({
            uri: server.hostPort + '/v1/?doc=&path=/this_is_no_a_path',
            headers: {
                accept: 'text/html'
            }
        })
        .then(function() {
            throw new Error('Error should be thrown');
        }, function(e) {
            assert.deepEqual(e.status, 404);
        });
    });

    it('should disallow unsecure relative paths for static serve', function() {
        return preq.get({
            uri: server.hostPort + '/v1/?doc=&path=../../../Test',
            headers: {
                accept: 'text/html'
            }
        })
        .then(function() {
            throw new Error('Error should be thrown');
        }, function(e) {
            assert.deepEqual(e.status, 500);
            assert.deepEqual(e.body.detail, 'Error: Invalid path.');
        });
    });

    it('should not list sys api', function () {
        return preq.get({
            uri: server.hostPort + '/'
        })
        .then(function(res) {
            assert.deepEqual(res.body, {
                items: [ 'v1' ]
            });
        });
    });

    it('should not allow doc requests to sys', function () {
        return preq.get({
            uri: server.hostPort + '/sys/?doc=',
            headers: {
                accept: 'text/html'
            }
        })
        .then(function() {
            throw new Error('Error should be thrown');
        }, function (e) {
            assert.deepEqual(e.status, 403);
        });
    });

    after(function() { return server.stop(); });
});
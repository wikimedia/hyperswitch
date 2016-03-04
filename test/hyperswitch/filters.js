"use strict";

var assert = require('../utils/assert.js');
var Server = require('../utils/server.js');
var preq   = require('preq');
var P      = require('bluebird');

describe('Documentation handling', function() {
    var server = new Server('test/hyperswitch/filters_config.yaml');

    before(function() { return server.start(); });

    it('should pick filters from path spec', function() {
        return preq.get({
            uri: server.hostPort + '/filtered'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.body.toString(), 'From Filter');
        });
    });

    it('should pick filters from method spec', function() {
        return preq.post({
            uri: server.hostPort + '/non_filtered'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.body.toString(), 'From Filter');
        });
    });

    it('should not apply filter to different method', function() {
        return preq.get({
            uri: server.hostPort + '/non_filtered'
        })
        .then(function(res) {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.body.toString(), 'From Handler');
        });
    });

    after(function() { return server.stop(); });
});

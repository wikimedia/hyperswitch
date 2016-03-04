"use strict";

var assert = require('../utils/assert.js');
var Server = require('../utils/server.js');
var preq   = require('preq');
var P      = require('bluebird');

function range(n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) {
        a[i] = i;
    }
    return a;
}

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

    // Rate limits
    it('Should allow low-volume access', function () {
        return P.each(range(10), function() {
            return preq.get({
                uri: server.hostPort + '/limited'
            })
            .delay(1200);
        });
    });

    // Disabled until the rate limiter actually throws.
    //
    // it('Should block high-volume access', function () {
    //     var limited = 0;
    //     return P.each(range(30), function() {
    //         return preq.get({
    //             uri: server.hostPort + '/limited'
    //         })
    //         .catch(function() {
    //             limited++;
    //         })
    //         .delay(500);
    //     }).then(function() {
    //         if (limited < 1) {
    //             throw new Error('Should have limited!');
    //         }
    //     });

    // });

    after(function() { return server.stop(); });
});

'use strict';

var assert = require('../utils/assert.js');
var lib = require('../../lib/regex');

describe('Regular expressions', () => {
    describe('should recognize internal addresses', () => {
        it('IPv4: loopback address to the local host', () => {
            assert.deepEqual(lib.LOCAL_IP.test('127.0.0.1'), true);
        });

        it('IPv4: private address, class A', () => {
            assert.deepEqual(lib.LOCAL_IP.test('10.0.0.1'), true);
        });

        it('IPv6: loopback address to the local host', () => {
            assert.deepEqual(lib.LOCAL_IP.test('::1'), true);
        });

        it('IPv6: IPv4 mapped address', () => {
            assert.deepEqual(lib.LOCAL_IP.test('::ffff:10.0.0.0'), true);
        });
    });

    describe('should recognize external addresses', () => {
        it('external IPv4 address', () => {
            assert.deepEqual(lib.LOCAL_IP.test('55.55.55.55'), false);
        });

        // https://phabricator.wikimedia.org/T247770
        it('external IPv4 address with a 10 inside', () => {
            assert.deepEqual(lib.LOCAL_IP.test('55.55.10.55'), false);
        });

        // https://phabricator.wikimedia.org/T247770
        it('external IPv4 address with a 127 inside', () => {
            assert.deepEqual(lib.LOCAL_IP.test('55.127.55.55'), false);
        });
    });
});

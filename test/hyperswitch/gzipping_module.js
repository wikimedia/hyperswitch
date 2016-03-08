"use strict";

var P = require('bluebird');
var zlib = require('zlib');

module.exports = function() {
    return {
        spec: {
            paths: {
                '/get': {
                    get: {
                        operationId: 'getContent'
                    }
                }
            }
        },
        operations: {
            getContent: function() {
                var zStream = zlib.createGzip({ level: 5 });
                zStream.end('TEST');
                return P.resolve({
                    status: 200,
                    headers: {
                        'content-encoding': 'gzip'
                    },
                    body: zStream
                });
            }
        }
    }
};
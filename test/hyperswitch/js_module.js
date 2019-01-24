"use strict";

var P = require('bluebird');
var zlib = require('zlib');
var URI = require('../../lib/exports').URI;

module.exports =() => {
    return {
        spec: {
            paths: {
                '/gzip': {
                    get: {
                        operationId: 'gzipContent'
                    }
                },
                '/remote': {
                    get: {
                        operationId: 'remoteContent'
                    }
                }
            }
        },
        operations: {
            gzipContent:() => {
                var zStream = zlib.createGzip({ level: 5 });
                zStream.end('TEST');
                return P.resolve({
                    status: 200,
                    headers: {
                        'content-encoding': 'gzip'
                    },
                    body: zStream
                });
            },
            remoteContent: (hyper) => {
                return hyper.get({
                    uri: new URI('https://en.wikipedia.org/wiki/Darth_Vader')
                });
            }
        }
    }
};
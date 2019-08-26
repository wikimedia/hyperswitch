'use strict';

var stream = require('stream');

function hello(hyper, req) {
    var body = new stream.PassThrough();
    body.end('hello');
    return {
        status: 200,
        headers: {
            'content-type': 'text/html',
        },
        body: body
    };
}

function buffer(hyper, req) {
    var body = new stream.PassThrough();
    body.write(Buffer.from('hel'));
    // Delay the final write to test async production.
    setTimeout(() => {
        body.end(Buffer.from('lo'));
    }, 500);

    return {
        status: 200,
        headers: {
            'content-type': 'text/html',
        },
        body: body
    };
}

function chunks(hyper, req) {
    var body = new stream.PassThrough();
    for (var i = 0; i < 100; i++) {
        body.write(i.toString());
    }
    body.end();
    return {
        status: 200,
        headers: {
            'content-type': 'text/html',
        },
        body: body
    };
}

module.exports = (options) => {
    return {
        spec: {
            paths: {
                '/hello': {
                    get: {
                        operationId: 'hello'
                    }
                },
                '/buffer': {
                    get: {
                        operationId: 'buffer'
                    }
                },
                '/chunks': {
                    get: {
                        operationId: 'chunks'
                    }
                }
            }
        },
        operations: {
            hello: hello,
            buffer: buffer,
            chunks: chunks,
        }
    };
};

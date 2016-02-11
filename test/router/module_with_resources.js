"use strict";

module.exports = function() {
    return {
        spec: {
            paths: {
                '/temp': {
                    operationId: 'operation'
                }
            }
        },
        operations: {
            operation: function() {}
        },
        resources: [
            {
                method: 'post',
                uri: '/testing/uri/that/will/be/checked/by/test',
                headers: {
                    test: 'test'
                },
                body: 'test'
            }
        ]
    }
};
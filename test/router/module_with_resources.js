"use strict";

module.exports =() => {
    return {
        spec: {
            paths: {
                '/temp': {
                    operationId: 'operation'
                }
            }
        },
        operations: {
            operation:() => {}
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
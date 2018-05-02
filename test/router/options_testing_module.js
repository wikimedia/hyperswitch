"use strict";

var assert = require('../utils/assert');

module.exports = function(options) {
    assert.deepEqual(options.simple_option, 'simple_option_value');
    assert.deepEqual(options.templated_option, 'test_conf_option_value');
    assert.deepEqual(options.templates, { sample_template: '{{should not be expanded}}' });
    assert.deepEqual(!!options.logger, true );
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
        }
    }
};
"use strict";

// mocha defines to avoid JSHint breakage
/* global describe, it, before, beforeEach, after, afterEach */

var Router = require('../../lib/router');
var assert = require('../utils/assert');
var fs     = require('fs');
var yaml   = require('js-yaml');

var fakeHyperSwitch = { config: {} };

var noopResponseHanlder = {
    'x-request-hander': [
        {
            return_something: {
                'return': {
                    status: 200
                }
            }
        }
    ]
};

var additionalMethodSpec = {
    paths: {
        '/{domain:en.wikipedia.org}/v1': {
            'x-modules': [
                {
                    path: 'subspec1.yaml'
                },
                {
                    path: 'subspec2.yaml'
                }
            ]
        }
    }
};

var noHandlerSpec = {
    paths: {
        '/test': {
            get: {
                operationId: 'unknown'
            }
        }
    }
};

var overlappingMethodSpec = {
    paths: {
        '/{domain:en.wikipedia.org}/v1': {
            'x-modules': [
                {
                    path: 'subspec1.yaml'
                },
                {
                    path: 'subspec1.yaml'
                }
            ]
        }
    }
};


var nestedSecuritySpec = {
    paths: {
        '/{domain:en.wikipedia.org}/v1': {
            'x-modules': [
                {
                    path: 'secure_subspec.yaml'
                }
            ],
            security: ['first']
        }
    }
};

describe('Router', function() {

    it('should allow adding methods to existing paths', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec(additionalMethodSpec, fakeHyperSwitch)
        .then(function() {
            var handler = router.route('/en.wikipedia.org/v1/page/Foo/html');
            assert.deepEqual(!!handler.value.methods.get, true);
            assert.deepEqual(!!handler.value.methods.post, true);
        });
    });

    it('should error on overlapping methods on the same path', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec(overlappingMethodSpec, fakeHyperSwitch)
        .then(function() {
            throw new Error("Should throw an exception!");
        },
        function(e) {
            assert.deepEqual(/^Trying to re-define existing metho/.test(e.message), true);
        });
    });

    it('should pass permission along the path to endpoint', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec(nestedSecuritySpec, fakeHyperSwitch)
        .then(function() {
            var handler = router.route('/en.wikipedia.org/v1/page/secure');
            assert.deepEqual(handler.permissions, [
                { value: 'first' },
                { value: 'second'},
                { value: 'third' },
                { value: 'fourth', method: 'get' }
            ]);
        });
    });
    it('should fail when no handler found for method', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec(noHandlerSpec, fakeHyperSwitch)
        .then(function() {
            throw new Error("Should throw an exception!");
        },
        function(e) {
            assert.deepEqual(e.message,
            'No known handler associated with operationId unknown');
        });
    });

    it('should not modify top-level spec-root', function() {
        var spec = yaml.safeLoad(fs.readFileSync(__dirname + '/multi_domain_spec.yaml'));
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec(spec, fakeHyperSwitch)
        .then(function() {
            var node = router.route('/test2');
            assert.deepEqual(node.value.path, '/test2');
        });
    });

    it('support loading modules from absolute paths', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test': {
                    'x-modules': [
                        { path: __dirname + '/api_module_1.yaml'}
                    ]
                }
            }
        }, fakeHyperSwitch)
    });

    it('supports merging api specs from different modules', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test': {
                    'x-modules': [
                        { path: 'api_module_1.yaml'},
                        { path: 'api_module_2.yaml'},
                    ]
                }
            }
        }, fakeHyperSwitch)
        .then(function() {
            var node = router.route(['test', 'api', { type: 'meta', name: 'apiRoot' }]);
            assert.deepEqual(!!node, true);
            assert.deepEqual(!!node.value, true);
            assert.deepEqual(!!node.value.specRoot, true);
            var spec = node.value.specRoot;
            assert.deepEqual(spec.definitions, {
                first_parameter: {description: 'First parameter definition'},
                second_parameter: {description: 'Second parameter definition'}
            });
            assert.deepEqual(Object.keys(spec.paths), ['/one', '/two']);
        });
    });

    it('supports exposing top-level spec', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec(yaml.safeLoad(fs.readFileSync(__dirname + '/root_api_spec.yaml')), fakeHyperSwitch)
        .then(function() {
            var node = router.route([{ type: 'meta', name: 'apiRoot' }]);
            assert.deepEqual(!!node, true);
            assert.deepEqual(!!node.value, true);
            assert.deepEqual(!!node.value.specRoot, true);
            var spec = node.value.specRoot;
            assert.deepEqual(spec.definitions, {
                some_object: {description: 'bla bla bla'}
            });
            assert.deepEqual(Object.keys(spec.paths), ['/test']);
        });
    });

    it('supports recursive matching with + modifier', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test/{+rest}': noopResponseHanlder
            }
        }, fakeHyperSwitch)
        .then(function() {
            var node = router.route('/test/foo/bar/baz');
            assert.deepEqual(!!node, true);
            assert.deepEqual(node.params.rest, 'foo/bar/baz');
        });
    });

    it('supports optional matching', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test{/rest}': noopResponseHanlder
            }
        }, fakeHyperSwitch)
        .then(function() {
            var node = router.route('/test/foo');
            assert.deepEqual(!!node, true);
            assert.deepEqual(node.params.rest, 'foo');
            node = router.route('/test');
            assert.deepEqual(!!node, true);
            assert.deepEqual(node.params.rest, undefined);
        });
    });

    it('does not explode on empty spec', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: { }
        }, fakeHyperSwitch);
    });

    it('passes options to modules', function() {
        var router = new Router({ appBasePath: __dirname });
        // The error is thrown by options_testing_module in case options are not passed correctly
        return router.loadSpec({
            paths: {
                '/test': {
                    'x-modules': [
                        {
                            path: __dirname + '/options_testing_module.js',
                            options: {
                                simple_option: 'simple_option_value',
                                templated_option: '{{options.test_conf_option}}',
                                templates: {
                                    sample_template: '{{should not be expanded}}'
                                }
                            }
                        }
                    ]
                }
            }
        }, { config: {
            test_conf_option: 'test_conf_option_value'
        }})
    });

    it('calls resources when module is created', function(done) {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test': {
                    'x-modules': [
                        {
                            path: __dirname + '/module_with_resources.js',
                        }
                    ]
                }
            }
        }, { config: {},
            request: function(req) {
                try {
                    var expectedRequest = {
                        method: 'post',
                        uri: '/testing/uri/that/will/be/checked/by/test',
                        headers: {
                            test: 'test'
                        },
                        body: 'test'
                    };
                    assert.deepEqual(req, expectedRequest);
                    done();
                } catch (e) {
                    done(e);
                }
            }
        })
    });

    it('finds module with in app basePath node_modules', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test': {
                    'x-modules': [
                        {
                            path: 'sample_module.js'
                        }
                    ]
                }
            }
        }, { config: {} })
        .then(function() {
            assert.deepEqual(!!router.route('/test/temp'), true);
        });
    });

    it('throws error if module is not found', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test': {
                    'x-modules': [
                        {
                            path: 'not_existing_module.js'
                        }
                    ]
                }
            }
        }, { config: {} })
        .then(function() {
            throw new Error('Error should be thrown');
        }, function(e) {
            assert.deepEqual(e.code, 'MODULE_NOT_FOUND');
            assert.deepEqual(e.moduleName, 'not_existing_module.js');
        });
    });

    it('throws error on invalid modules definition', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test': {
                    'x-modules': {
                        path: 'not_existing_module.js'
                    }
                }
            }
        }, { config: {} })
        .then(function() {
            throw new Error('Error should be thrown');
        }, function(e) {
            assert.deepEqual(/^Invalid modules definition/.test(e.message), true);
        });
    });

    it('supports multiple optional parameters', function() {
        var router = new Router({ appBasePath: __dirname });
        return router.loadSpec({
            paths: {
                '/test{/key1}{/key2}': {
                    'get': {
                        'x-request-handler': [
                            { do_request: {
                                    return: {
                                        status: 200
                                    }
                                }
                            }
                        ]
                    }
                }
            }
        }, { config: {} })
        .then(function() {
            assert.deepEqual(router.route('/test/value1/value2').params,
                { key1 : 'value1', key2: 'value2' });
        });
    });
});

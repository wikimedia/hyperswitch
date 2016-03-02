"use strict";

// mocha defines to avoid JSHint breakage
/* global describe, it, before, beforeEach, after, afterEach */

var assert = require('./../utils/assert.js');
var validator = require('../../lib/filters/validator');

var testValidator = function (req, parameters) {
    return validator(null, req, function () {
    }, null, {
        spec: {
            parameters: parameters
        }
    });
};

describe('Validator filter', function () {

    it('Should validate request for required fields', function () {
        try {
            testValidator({
                body: {
                    otherParam: 'test'
                }
            }, [{
                name: 'testParam',
                in: 'formData',
                required: true
            }]);
            throw new Error('Error should be thrown');
        } catch (e) {
            assert.deepEqual(e.constructor.name, 'HTTPError');
            assert.deepEqual(e.body.detail, "data.body should have required property 'testParam'");
        }
    });

    it('Should compile validator with no required fields', function () {
        testValidator({
            body: {}
        }, [{
            name: 'testParam',
            in: 'formData'
        }]);
    });

    it('Should validate integers', function () {
        try {
            testValidator({
                query: {
                    testParam: 'not_an_integer'
                }
            }, [{
                name: 'testParam',
                in: 'query',
                type: 'integer',
                required: true
            }]);
            throw new Error('Error should be thrown');
        } catch (e) {
            assert.deepEqual(e.constructor.name, 'HTTPError');
            assert.deepEqual(e.body.detail, 'data.query.testParam should be an integer');
        }
    });

    it('Should validate object schemas', function () {
        try {
            testValidator({
                body: {
                    field1: 'some string'
                }
            }, [{
                name: 'testParam',
                in: 'body',
                schema: {
                    type: 'object',
                    properties: {
                        field1: {
                            type: 'string'
                        },
                        field2: {
                            type: 'string'
                        }
                    },
                    required: ['field1', 'field2']
                },
                required: true
            }]);
            throw new Error('Error should be thrown');
        } catch (e) {
            assert.deepEqual(e.constructor.name, 'HTTPError');
            assert.deepEqual(e.body.detail, "data.body should have required property 'field2'");
        }
    });

    it('Should allow floats in number validator', function () {
        testValidator({
            query: {
                testParam1: '27.5',
                testParam2: '27,5'
            }
        }, [
            {
                name: 'testParam1',
                in: 'query',
                type: 'number',
                required: true
            },
            {
                name: 'testParam2',
                in: 'query',
                type: 'number',
                required: true
            }
        ]);
    });

    it('Should coerce boolean parameters', function () {
        var req = {
            query: {
                boolParamTrue: 'true',
                boolParamTrueUpperCase: 'True',
                boolParamFalse: 'false',
                boolParamFalseUpperCase: 'False',
                boolParam0: '0',
                boolParam1: '1'
            }
        };
        testValidator(req, [
            {name: 'boolParamTrue', in: 'query', type: 'boolean'},
            {name: 'boolParamTrueUpperCase', in: 'query', type: 'boolean'},
            {name: 'boolParamFalse', in: 'query', type: 'boolean'},
            {name: 'boolParamFalseUpperCase', in: 'query', type: 'boolean'},
            {name: 'boolParam0', in: 'query', type: 'boolean'},
            {name: 'boolParam1', in: 'query', type: 'boolean'},
        ]);
        assert.deepEqual(req.query.boolParamTrue, true);
        assert.deepEqual(req.query.boolParamTrueUpperCase, true);
        assert.deepEqual(req.query.boolParamFalse, false);
        assert.deepEqual(req.query.boolParamFalseUpperCase, false);
        assert.deepEqual(req.query.boolParam0, false);
        assert.deepEqual(req.query.boolParam1, true);
    });

    it('Should not coerce string parameters', function () {
        var req = {
            query: {
                stringParam: 'true'
            }
        };
        testValidator(req, [
            {name: 'stringParam', in: 'query', type: 'string'}
        ]);
        assert.deepEqual(req.query.stringParam, 'true');
    });

    it('Should not coerce formData for application/json', function () {
        try {
            // The type is incorrect, but wouldn't be coerced, so error will be thrown
            testValidator({
                headers: {
                    'content-type': 'application/json'
                },
                body: {
                    bodyParam: 'true'
                }
            }, [
                {name: 'bodyParam', in: 'formData', type: 'boolean', required: true}
            ]);
            throw new Error('Should throw error');
        } catch (e) {
            assert.deepEqual(e.constructor.name, 'HTTPError');
            assert.deepEqual(e.body.detail, "data.body.bodyParam should be boolean");
        }
        // Now all is fine, shouldn't throw an error
        testValidator({
            headers: {
                'content-type': 'application/json'
            },
            body: {
                bodyParam: true
            }
        }, [
            {name: 'bodyParam', in: 'formData', type: 'boolean', required: true}
        ]);
        // Without 'application/json' coercion should be applied
        var req = {
            body: {
                bodyParam: 'true'
            }
        };
        testValidator(req, [
            {name: 'bodyParam', in: 'formData', type: 'boolean', required: true}
        ]);
        assert.deepEqual(req.body.bodyParam, true);
    });

    it('Should accept body params without a schema and type', function () {
        testValidator({
            body: {
                test: 'test'
            }
        }, [
            {name: 'bodyParam', in: 'body', required: true}
        ]);
        try {
            // The type is incorrect, but wouldn't be coerced, so error will be thrown
            testValidator({
                body: 'This is a string, and body param must be an object'
            }, [
                {name: 'bodyParam', in: 'body', required: true}
            ]);
            throw new Error('Should throw error');
        } catch (e) {
            assert.deepEqual(e.constructor.name, 'HTTPError');
            assert.deepEqual(e.body.detail, "data.body should be object");
        }
    });

    it('Should allow non-required body', function () {
        testValidator({}, [
            {name: 'bodyParam', in: 'body'}
        ]);
    });

    it('Should list options for enum errors', function() {
        try {
            testValidator({
                query: {
                    queryParam: 'four'
                }
            }, [
                {
                    name: 'queryParam',
                    in: 'query',
                    type: 'string',
                    enum: [ 'one', 'two', 'three' ],
                    required: 'true'
                }
            ]);
            throw new Error('Should throw error');
        } catch (e) {
            assert.deepEqual(e.constructor.name, 'HTTPError');
            assert.deepEqual(e.body.detail, "data.query.queryParam should be equal to " +
                "one of the allowed values: [one, two, three]");
        }
    });
});
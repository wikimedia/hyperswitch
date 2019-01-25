'use strict';

var handlerTemplate = require('../../lib/handlerTemplate');
var assert = require('./../utils/assert.js');

describe('Handler Template Spec Validation',() => {
    function testValidation(action, expectedError) {
        var caught;
        try {
            action();
        } catch (e) {
            caught = true;
            assert.deepEqual(expectedError.test(e.message), true);
        }
        if (!caught) {
            throw new Error('Error should be thrown');
        }
    }

    it('Checks parallel returning requests',() => {
        testValidation(() => {
            handlerTemplate.createHandler([{
                get_one: {
                    request: {
                        uri: 'http://en.wikipedia.org/wiki/One'
                    },
                    return: '{$.get_one}'
                },
                get_two: {
                    request: {
                        uri: 'http://en.wikipedia.org/wiki/Two'
                    },
                    return: '{$.get_two}'
                }
            }]);
        }, /^Invalid spec\. Returning requests cannot be parallel\..*/);
    });

    it('Requires either return or request',() => {
        testValidation(() => {
            handlerTemplate.createHandler([{
                get_one: {}
            }]);
        }, /^Invalid spec\. Either request or return must be specified\..*/);
    });

    it('Compiles a valid condition function',() => {
        handlerTemplate.createHandler([{
            get_one: {
                request: {
                    uri: '/my/path'
                },
                return_if: {
                    status: '5xx'
                },
                return: '{$.request}'
            }
        }]);
    });

    it('Requires request for return_if',() => {
        testValidation(() => {
            handlerTemplate.createHandler([{
                get_one: {
                    return_if: {
                        status: '5xx'
                    },
                    return: '$.request'
                }
            }]);
        }, /^Invalid spec\. return_if should have a matching request\..*/);
    });

    it('Requires request for catch',() => {
        testValidation(() => {
            handlerTemplate.createHandler([{
                get_one: {
                    catch: {
                        status: '5xx'
                    },
                    return: '$.request'
                }
            }]);
        }, /^Invalid spec\. catch should have a matching request\..*/);
    });

    it('Requires correct catch definition',() => {
        testValidation(() => {
            handlerTemplate.createHandler([{
                get_one: {
                    request: {
                        uri: 'test_path'
                    },
                    catch: {
                        status: 'asdf'
                    },
                    return: '$.request'
                }
            }]);
        }, /^Invalid catch condition asdf.*/);
    });

    it('Requires spec to be an array',() => {
        testValidation(() => {
            handlerTemplate.createHandler({
                this_is_illegal: 'very illegal'
            });
        }, /^Invalid spec. It must be an array of request block definitions\..*/);
    });

    it('Requires a return if the last step is parallel',() => {
        testValidation(() => {
            handlerTemplate.createHandler([{
                get_one: {
                    request: {
                        uri: 'http://en.wikipedia.org/wiki/One'
                    }
                },
                get_two: {
                    request: {
                        uri: 'http://en.wikipedia.org/wiki/Two'
                    }
                }
            }]);
        }, /^Invalid spec. Need a return if the last step is parallel\./)
    });
});
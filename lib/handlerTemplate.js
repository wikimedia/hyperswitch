'use strict';

/*
 * A backend request handler definition template, that compiles a handler spec
 * into an executable function.
 */

const P = require('bluebird');
const Template = require('swagger-router').Template;
const stringify = require('json-stable-stringify');

/**
 * Creates a JS function that verifies property equality
 * @param {Object} catchDefinition the condition in the format of 'catch' and 'return_if' stanza
 * @return {Function} a function that verifies the condition
 */
function compileCatchFunction(catchDefinition) {
    function createCondition(catchCond, option) {
        if (catchCond === 'status') {
            const opt = option.toString();
            if (/^[0-9]+$/.test(opt)) {
                return `(res["${catchCond}"] === ${opt})`;
            } else if (/^[0-9x]+$/.test(opt)) {
                return `Array.isArray(res["${catchCond
                }"].toString().match(/^${opt.replace(/x/g, "\\d")
                }$/))`;
            } else {
                throw new Error(`Invalid catch condition ${opt}`);
            }
        } else {
            return `(stringify(res["${catchCond}"]) === '${stringify(option)}')`;
        }
    }

    const condition = [];
    Object.keys(catchDefinition).forEach((catchCond) => {
        if (Array.isArray(catchDefinition[catchCond])) {
            const orCondition = catchDefinition[catchCond].map((option) => {
                return createCondition(catchCond, option);
            });
            condition.push(`(${orCondition.join(' || ')})`);
        } else {
            condition.push(createCondition(catchCond, catchDefinition[catchCond]));
        }
    });
    const code = `return (${condition.join(' && ')});`;
    /* jslint evil: true */
    /* eslint-disable no-new-func */
    return new Function('stringify', 'res', code).bind(null, stringify);
    /* eslint-disable no-new-func */
}

/**
 * Count the number of request step stanzas with 'return' or 'return_if'
 * statements.
 * @param {Object} stepConf step config object
 * @return {boolean} true if there's 'return' or 'return_if' in the step
 */
function countReturnsInStep(stepConf, withConditionals) {
    return Object.keys(stepConf)
        .filter((requestName) => {
            return stepConf[requestName].return
                ||  withConditionals && stepConf[requestName].return_if;
        })
        .length;
}

/**
 * Validates a single step in the request chain
 * @param {Object} stepConf step configuration with optional
 *                 'request', 'return', 'return_if' and 'catch' properties.
 */
function validateStep(stepConf) {
    // Returning steps can't be parallel
    const returnsInStep = countReturnsInStep(stepConf, true);
    if (returnsInStep > 1) {
        throw new Error(`${'Invalid spec. ' +
        'Returning requests cannot be parallel. Spec: '}${JSON.stringify(stepConf)}`);
    }

    // Either 'request' or 'return' must be specified
    if (!Object.keys(stepConf).every((requestName) => {
        return stepConf[requestName].request || stepConf[requestName].return;
    })) {
        throw new Error(`${'Invalid spec. ' +
        'Either request or return must be specified. Step: '}${JSON.stringify(stepConf)}`);
    }

    // Only supply 'return_if' when 'request' is specified
    if (Object.keys(stepConf).some((requestName) => {
        return stepConf[requestName].return_if && !stepConf[requestName].request;
    })) {
        throw new Error(`${'Invalid spec. ' +
        'return_if should have a matching request. Step: '}${JSON.stringify(stepConf)}`);
    }

    // Only supply 'catch' when 'request' is specified
    if (Object.keys(stepConf).some((requestName) => {
        return stepConf[requestName].catch && !stepConf[requestName].request;
    })) {
        throw new Error(`${'Invalid spec. ' +
        'catch should have a matching request. Step: '}${JSON.stringify(stepConf)}`);
    }
}

/**
 * Validates the specification of the service,
 * throws Error if some of the rules are not met.
 * Current rules:
 *  - request handler spec must be an array
 *  - returning steps can't be parallel
 *  - either 'request' or 'return' must be specified in each step
 *  - 'return_if' is allowed only if 'request' is specified in a step
 *  - 'catch' is allowed only if 'request' is specified in a step
 *  - last step in a request chain can't be parallel
 * @param {Object} spec service spec object
 */
function validateSpec(spec) {
    if (!spec || !Array.isArray(spec)) {
        throw new Error(`${'Invalid spec. It must be an array of request block definitions.' +
            ' Spec: '}${JSON.stringify(spec)}`);
    }
    spec.forEach(validateStep);

    // Last step must have a return, or only a single request.
    const lastStep = spec[spec.length - 1];
    if (countReturnsInStep(lastStep) === 0) {
        if (Object.keys(lastStep).length > 1) {
            throw new Error('Invalid spec. Need a return if the last step is parallel.');
        } else {
            // Make the last step a return step.
            const lastRequestName = Object.keys(lastStep)[0];
            lastStep[lastRequestName].return = true;
        }
    }
}

function courteousExpand(template, ctx, info) {
    try {
        return template.expand(ctx.model);
    } catch (e) {
        e.reqName = info.reqName;
        e.reqSpec = info.spec;
        throw e;
    }
}

/**
 * Creates a request handler.
 * @param {Object} info about a request.
 *          - {string} name: request name
 *          - {Object} spec: object containing a request template
 * @return {Function}
 */
function makeRequestHandler(info, options) {
    if (info.spec.request) {
        let template;
        try {
            template = new Template(info.spec.request, options.globals);
        } catch (e) {
            e.requestName = info.name;
            e.requestSpec = info.spec.spec;
            e.message = `Template compilation failed. See .spec for details. ${e.message}`;
            throw e;
        }

        let catchPred;
        if (info.spec.catch) {
            catchPred = compileCatchFunction(info.spec.catch);
        }

        let shouldReturn;
        // Important: `return_if` takes precedence over return, so that a
        // `return` with `return_if` present behaves like `response`.
        if (info.spec.return_if) {
            // Conditional return.
            const returnPred = compileCatchFunction(info.spec.return_if);
            shouldReturn = res => returnPred(res) && info.name;
        } else if (info.spec.return) {
            // Unconditional return.
            shouldReturn = () => info.name;
        } else {
            shouldReturn = () => false;
        }

        // Specialized version for performance.
        if (catchPred) {
            return (ctx) => {
                const req = courteousExpand(template, ctx, info);
                if (!req.method) {
                    // TODO: trace down callers that don't set a proper method!
                    req.method = ctx.model.request.method
                        || options.defaultMethod || 'get';
                }
                return ctx.hyper.request(req)
                .then((res) => {
                    ctx.model[info.name] = res;
                    ctx._doReturn = ctx._doReturn || shouldReturn(res);
                }, (res) => {
                    ctx.model[info.name] = res;
                    if (catchPred(res)) {
                        ctx._doReturn = ctx._doReturn || shouldReturn(res);
                    } else {
                        res.requestName = info.name;
                        throw res;
                    }
                });
            };
        } else if (!info.spec.return_if && info.spec.return) {
            return (ctx) => {
                const req = courteousExpand(template, ctx, info);
                if (!req.method) {
                    // TODO: trace down callers that don't set a proper method!
                    req.method = ctx.model.request.method
                        || options.defaultMethod || 'get';
                }
                // Set up the return no matter what.
                ctx._doReturn = info.name;
                return ctx.hyper.request(req)
                .then((res) => {
                    ctx.model[info.name] = res;
                    ctx._doReturn = info.name;
                });
            };
        } else {
            return (ctx) => {
                const req = courteousExpand(template, ctx, info);
                if (!req.method) {
                    // TODO: trace down callers that don't set a proper method!
                    req.method = ctx.model.request.method
                        || options.defaultMethod || 'get';
                }
                return ctx.hyper.request(req)
                .then((res) => {
                    ctx.model[info.name] = res;
                    ctx._doReturn = ctx._doReturn || shouldReturn(res);
                });
            };
        }
    }
}

function makeResponseHandler(info, options) {
    const returnOrResponse = info.spec.return || info.spec.response;
    if (returnOrResponse) {
        const doReturn = info.spec.return && !info.spec.return_if && info.name;
        const conditionalReturn = info.spec.return_if;
        if (typeof returnOrResponse === 'object') {
            const template = new Template(returnOrResponse, options.globals);
            return (ctx) => {
                // Don't evaluate if a conditional return didn't trigger, as
                // that is often used to handle error conditions.
                if (ctx._doReturn || !conditionalReturn) {
                    ctx.model[info.name] = courteousExpand(template, ctx, info);
                }
                ctx._doReturn = ctx._doReturn || doReturn;
            };
        }
    }
}

// Set up the request phase in a parallel execution step.
function makeStepRequestHandler(reqHandlerInfos) {
    const handlers = [];
    reqHandlerInfos.forEach((info) => {
        if (info.requestHandler) {
            handlers.push((ctx) => {
                return info.requestHandler(ctx)
                .catch((e) => {
                    e.requestName = info.name;
                    throw e;
                });
            });
        }
    });

    if (handlers.length) {
        // Call all request handlers in a step in parallel.
        return ctx => P.map(handlers, (handler) => {
            return handler(ctx);
        });
    } else {
        // Nothing to do.
        return null;
    }
}

// Set up the response massaging phase for requests in a parallel execution
// step.
function makeStepResponseHandler(reqHandlerInfos) {
    const returnHandlerInfos = [];
    reqHandlerInfos.forEach((info) => {
        if (info.responseHandler) {
            returnHandlerInfos.push({
                name: info.name,
                handler: info.responseHandler,
            });
        }
    });

    if (returnHandlerInfos.length) {
        return (ctx) => {
            returnHandlerInfos.forEach((info) => {
                try {
                    info.handler(ctx);
                } catch (e) {
                    e.requestName = info.name;
                    throw e;
                }
            });
        };
    } else {
        return null;
    }
}

/**
 * Set up a handler function to run one full step.
 *
 * - Compile all requests in the step into request / response handlers.
 * - Aggregate those into two handlers for step-global request & response
 *   phases.
 * - Return the right Promise arrangement to call both, in order.
 */
function makeStep(stepSpec, options) {
    const reqHandlerInfos = Object.keys(stepSpec).map((reqName) => {
        const reqSpec = stepSpec[reqName];
        const reqHandlerInfo = {
            name: reqName,
            spec: reqSpec,
        };
        reqHandlerInfo.requestHandler = makeRequestHandler(reqHandlerInfo, options);
        reqHandlerInfo.responseHandler = makeResponseHandler(reqHandlerInfo, options);

        return reqHandlerInfo;
    });

    // Create one function to call all handlers in a step.
    //
    // We execute the requests in a single step in two phases avoid race
    // conditions between parallel requests referencing each other:
    // 1) execute all requests, .catch, and evaluate return_if conditions
    const requestHandler = makeStepRequestHandler(reqHandlerInfos);

    // 2) Massage the response(s) by applying return / response specs.
    const responseHandler = makeStepResponseHandler(reqHandlerInfos);

    // Returns are signaled via ctx._doReturn, set in the requestHandler if
    // `return` is set or the `return_if` condition evaluates to `true` based
    // on the original response.

    if (requestHandler) {
        if (responseHandler) {
            return ctx => requestHandler(ctx)
                .then(() => {
                    return responseHandler(ctx);
                });
        } else {
            return requestHandler;
        }
    } else if (responseHandler) {
        return ctx => P.resolve(responseHandler(ctx));
    } else {
        // Really nothing to do at all.
        return ctx => P.resolve(ctx);
    }
}

/**
 * Run one step at a time, and take care of returning the right value /
 * scheduling the next step.
 */
function runStep(steps, i, ctx) {
    const step = steps[i];
    const stepPromise = step(ctx);
    if (i < steps.length - 1) {
        return stepPromise.then(() => {
            if (ctx._doReturn) {
                return ctx.model[ctx._doReturn];
            } else {
                return runStep(steps, i + 1, ctx);
            }
        });
    } else {
        // All done. Return in any case.
        return stepPromise.then(() => {
            return ctx.model[ctx._doReturn];
        });
    }
}


/**
 * Creates a handler function from the handler spec.
 * @param {Object} spec - a request handler spec
 * @param {Object} options with attributes:
 * @param {Object} options.globals: an object to merge into the globals available in the
 *                  global handler scope.
 * @param {string} options.defaultMethod: request method used for templates without an
 *                  explicit method set; defaults to 'get'.
 * @return {Function} a request handler
 */
function createHandler(spec, options) {
    options = options || {};
    if (!options.globals) { options.globals = {}; }

    validateSpec(spec);

    // Remember non-functions in options.globals, so that we can add them to
    // the model.
    let modelInit = {};
    Object.keys(options.globals).forEach((key) => {
        if (typeof options.globals[key] !== 'function') {
            modelInit[key] = options.globals[key];
        }
    });
    if (!Object.keys(modelInit).length) {
        modelInit = null;
    }

    // Compile all the parallel execution steps into functions.
    const steps = spec.map((stepSpec) => {
        return makeStep(stepSpec, options);
    });

    return (hyper, req) => {
        const ctx = {
            hyper,
            // The root model exposed to templates.
            model: {
                request: req,
            },

            // This contains the name of the request to return, once it is
            // ready to be returned. This is triggered unconditionally by the
            // return: statement, and conditionally by the return_if:
            // statement if its predicate evaluates to true.
            _doReturn: false,
            _spec: spec,
        };
        if (modelInit) {
            const model = ctx.model;
            // Don't use Object.assign, as we want to give precedence to the
            // model.
            Object.keys(modelInit).forEach((key) => {
                if (model[key] === undefined) {
                    model[key] = modelInit[key];
                }
            });
        }
        return runStep(steps, 0, ctx);
    };
}

/**
 * Processes an x-setup-handler config and returns all resources
 * @param {Object} setupConf an endpoint configuration object
 * @param {Object} options with attributes:
 *          - globals: an object to merge into the globals available in the
 *                  global handler scope.
 *
 * TODO: Use createHandler to create a real handler?
 */
function parseSetupConfig(setupConf, options) {
    const result = [];
    if (Array.isArray(setupConf)) {
        setupConf.forEach((resourceSpec) => {
            Object.keys(resourceSpec).forEach((requestName) => {
                const requestSpec = resourceSpec[requestName];
                requestSpec.method = requestSpec.method || 'put';
                result.push(requestSpec);
            });
        });
    } else {
        throw new Error('Invalid config. x-setup-handler must be an array');
    }
    return result;
}

module.exports = {
    createHandler,
    parseSetupConfig
};


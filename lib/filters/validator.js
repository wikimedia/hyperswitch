'use strict';

const HTTPError = require('./../exports').HTTPError;
const constructAjv = require('ajv');

/**
 * Mapping of `param.in` field to the name of a request part.
 *
 * @const
 * @type {{path: string, query: string, header: string, formData: string, body: string}}
 */
const inMapping = {
    path: 'params',
    query: 'query',
    header: 'headers',
    formData: 'body',
    body: 'body'
};

/**
 * Supported field validators.
 *
 * @const
 * @type {string[]}
 */
const supportedValidators = ['maximum',
    'exclusiveMaximum',
    'minimum',
    'exclusiveMinimum',
    'maxLength',
    'minLength',
    'pattern',
    'maxItems',
    'minItems',
    'uniqueItems',
    'enum',
    'multipleOf'];

/**
 * Constructs a request validator, according to swagger parameters specification.
 * A returned object contains a single `validate(req)` function.
 * @param {Array} parameters  swagger parameters spec
 * @constructor
 */
class Validator {
    constructor(parameters, definitions) {
        this._ajv = constructAjv({ verbose: true });
        if (definitions) {
            Object.keys(definitions).forEach((schemaName) => {
                this._ajv.addSchema(
                    definitions[schemaName],
                    `#/definitions/${schemaName}`
                );
            });
        }

        this._paramCoercionFunc = this._createTypeCoercionFunc(parameters.filter((p) => {
            return p.in !== 'formData' && p.in !== 'body' && p.type !== 'string';
        }));
        const bodyParams = parameters.filter((p) => p.in === 'body');
        if (bodyParams.length > 1) {
            throw new Error('Only a single body parameter allowed');
        } else if (bodyParams.length) {
            // Have a body parameter, special-case coercion to support formData and JSON
            const bodyParam = bodyParams[0];
            if (bodyParam.schema && bodyParam.schema.properties) {
                this._bodyCoercionFunc = this._createTypeCoercionFunc(
                    Object.keys(bodyParam.schema.properties).map((prop) => {
                        return {
                            name: prop,
                            in: 'body',
                            type: bodyParam.schema.properties[prop].type,
                            required: bodyParam.schema.required &&
                                bodyParam.schema.required.indexOf(prop) !== -1
                        };
                    }));
            }
        } else {
            this._bodyCoercionFunc = this._createTypeCoercionFunc(parameters.filter((p) => {
                return p.in === 'formData' && p.type !== 'string';
            }));
        }
        this._validatorFunc = this._ajv.compile(this._convertToJsonSchema(parameters));
    }

    /**
     * Validates a request. In case of an error, throws HTTPError with 400 code
     * @param {Object}  req a request object to validate.
     * @return {Object}     validated request object
     * @throws {HTTPError}
     */
    validate(req) {
        if (this._paramCoercionFunc) {
            req = this._paramCoercionFunc(req, HTTPError);
        }
        if (this._bodyCoercionFunc &&
                (!req.headers || !/^ *application\/json/i.test(req.headers['content-type']))) {
            req = this._bodyCoercionFunc(req, HTTPError);
        }
        if (!this._validatorFunc(req)) {
            let message;
            const error = this._validatorFunc.errors[0];
            if (error.keyword === 'enum') {
                message = `data${error.dataPath} ${
                    error.message}: [${error.schema.join(', ')}]`;
            } else {
                message = this._ajv.errorsText(this._validatorFunc.errors);
            }
            throw new HTTPError({
                status: 400,
                body: {
                    type: 'bad_request',
                    title: 'Invalid parameters',
                    detail: message,
                    req
                }
            });
        }
        return req;
    }
}

/**
 * Converts a list of parameters from a swagger spec
 * to JSON-schema for a request
 * @param {Array} parameters list of params
 * @return {Object} JSON schema
 * @private
 */
Validator.prototype._convertToJsonSchema = function (parameters) {
    const schema = {
        type: 'object',
        properties: {}
    };

    parameters.forEach((param) => {
        if (param.in !== 'body') {
            if (!schema.properties[inMapping[param.in]]) {
                schema.properties[inMapping[param.in]] = {
                    type: 'object',
                    properties: {}
                };
                // 'required' array must have at least one element according to json-schema spec,
                // se we can't preinitialize it.
                schema.required = schema.required || [];
                schema.required.push(inMapping[param.in]);
            }

            const reqPartSchema = schema.properties[inMapping[param.in]];
            const paramSchema = { type: param.type };
            supportedValidators.forEach((validator) => {
                paramSchema[validator] = param[validator];
            });
            reqPartSchema.properties[param.name] = paramSchema;
            if (param.required) {
                reqPartSchema.required = reqPartSchema.required || [];
                reqPartSchema.required.push(param.name);
            }
        } else {
            if (param.schema) {
                schema.properties.body = param.schema;
            } else {
                schema.properties.body = {
                    type: 'object'
                };
            }
            if (param.required) {
                schema.required = schema.required || [];
                schema.required.push('body');
            }
        }
    });

    return schema;
};

/**
 * Creates a function, that tries to coerce types of parameters in the
 * incoming request, according to the provided parameters specification.
 * @param  {Array} parameters parameters swagger specification
 * @return {Function<req, HTTPError>} coercion function
 * @private
 */
Validator.prototype._createTypeCoercionFunc = function (parameters) {
    let code = '';
    parameters.forEach((param) => {
        const paramAccessor = `req.${inMapping[param.in]}["${param.name}"]`;
        let paramCoercionCode = '';
        let errorNotifier;
        switch (param.type) {
            case 'integer':
                errorNotifier = `${'throw new HTTPError({status:400,body:{type:"bad_request",' +
                ' title:"Invalid parameters", detail: "data.'}${
                    inMapping[param.in]}.${param.name} should be an integer"}});\n`;
                paramCoercionCode += `${paramAccessor} = parseInt(${paramAccessor});\n` +
                    `if (!Number.isInteger(${paramAccessor})) {\n${errorNotifier}}\n`;
                break;
            case 'number':
                errorNotifier = `${'throw new HTTPError({status:400,body:{type:"bad_request",' +
                ' title:"Invalid parameters", detail: "data.'}${
                    inMapping[param.in]}.${param.name} should be a number"}});\n`;
                paramCoercionCode += `${paramAccessor} = parseFloat(${paramAccessor});\n` +
                    `if (Number.isNaN(${paramAccessor})) {\n${errorNotifier}}\n`;
                break;
            case 'boolean':
                errorNotifier = `${'throw new HTTPError({status:400,body:{type:"bad_request",' +
                    ' title:"Invalid parameters", detail: "data.'}${
                    inMapping[param.in]}.${param.name} should be a boolean.` +
                    ' true|false|1|0|yes|no is accepted as a boolean."}});\n';
                paramCoercionCode += `if(!/^true|false|1|0|yes|no$/i.test(${
                    paramAccessor} + "")) {\n${
                    errorNotifier}}\n${
                    paramAccessor} = /^true|1|yes$/i.test(${
                    paramAccessor} + "");\n`;
                break;
            case 'object':
                errorNotifier = `${'throw new HTTPError({status:400,body:{type:"bad_request",' +
                ' title:"Invalid parameters", detail: "data.'}${
                    inMapping[param.in]}.${param.name} should be a JSON object."}});\n`;
                paramCoercionCode += `try{${paramAccessor}=JSON.parse(${paramAccessor})` +
                    `}catch(e){${errorNotifier}}`;
                break;
            default:
                paramCoercionCode = '';
        }

        if (paramCoercionCode) {
            let wrapperConditions = `typeof ${paramAccessor} === 'string'`;
            if (!param.required) {
                // If parameter is not required, don't try to coerce "undefined"
                wrapperConditions += ` && ${paramAccessor} !== undefined`;
            }
            paramCoercionCode = `if (${wrapperConditions}) {\n${
                paramCoercionCode}}\n`;
        }

        code += paramCoercionCode;
    });
    if (code && code.trim()) {
        code += '\nreturn req;\n';
        /* eslint-disable no-new-func */
        return new Function('req', 'HTTPError', code);
        /* eslint-enable no-new-func */
    } else {
        return undefined;
    }
};

const CACHE = new Map();

module.exports = (hyper, req, next, options, specInfo) => {
    if (specInfo && specInfo.spec && specInfo.spec.parameters) {
        const cachedValidator = CACHE.get(specInfo.spec);
        if (cachedValidator) {
            cachedValidator.validate(req);
        } else {
            const validator = new Validator(
                specInfo.spec.parameters,
                specInfo.specRoot && specInfo.specRoot.definitions
            );
            CACHE.set(specInfo.spec, validator);
            validator.validate(req);
        }
    }
    return next(hyper, req);
};

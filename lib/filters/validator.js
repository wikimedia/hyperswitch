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
    // Does not support validating parameters or requestBodies in components
    constructor(parameters = [], requestBody = {}, schemas) {
        this._ajv = constructAjv({ verbose: true });
        if (schemas) {
            Object.keys(schemas).forEach((schemaName) => {
                this._ajv.addSchema(
                    schemas[schemaName],
                    `#/components/schemas/${schemaName}`
                );
            });
        }

        this._paramCoercionFunc = this._createTypeCoercionFunc(parameters.filter((p) => {
            return p.schema.type !== 'string';
        }));

        if (requestBody.content) {
            // Have a body parameter, special-case coercion to support form-data and JSON
            const reqContent = requestBody.content;

            // Only supports one possible content-type of the body
            const bodyType = Object.keys(reqContent)[0];

            if (reqContent[bodyType].schema && reqContent[bodyType].schema.properties) {
                this._bodyCoercionFunc = this._createTypeCoercionFunc(
                    Object.keys(reqContent[bodyType].schema.properties)
                        .map((prop) => {
                            return {
                                name: prop,
                                in: 'body',
                                schema: {
                                    type: reqContent[bodyType].schema.properties[prop].type
                                },
                                required: reqContent[bodyType].schema.required &&
                                    reqContent[bodyType].schema.required.indexOf(prop) !== -1
                            };
                        })
                );
            }
        }
        this._validatorFunc = this._ajv.compile(this._convertToJsonSchema(parameters, requestBody));
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
 * @param {Object} requestBody schema
 * @return {Object} JSON schema
 * @private
 */
Validator.prototype._convertToJsonSchema = function (parameters, requestBody) {
    const schema = {
        type: 'object',
        properties: {}
    };

    parameters.forEach((param) => {
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
        const paramSchema = { type: param.schema.type };

        supportedValidators.forEach((validator) => {
            paramSchema[validator] = param.schema[validator];
        });
        reqPartSchema.properties[param.name] = paramSchema;
        if (param.required) {
            reqPartSchema.required = reqPartSchema.required || [];
            reqPartSchema.required.push(param.name);
        }
    });

    if (requestBody.content) {
        const bodyType =  Object.keys(requestBody.content)[0];

        if (requestBody.content[bodyType].schema) {
            schema.properties.body = requestBody.content[bodyType].schema;
        } else {
            schema.properties.body = {
                type: 'object'
            };
        }
        if (requestBody.required) {
            schema.required = schema.required || [];
            schema.required.push('body');
        }
    }

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
        switch (param.schema.type) {
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
    if (specInfo && specInfo.spec && (specInfo.spec.parameters || specInfo.spec.requestBody)) {
        const cachedValidator = CACHE.get(specInfo.spec);
        if (cachedValidator) {
            cachedValidator.validate(req);
        } else {
            const validator = new Validator(
                specInfo.spec.parameters,
                specInfo.spec.requestBody,
                specInfo.specRoot.components && specInfo.specRoot.components.schemas
            );
            CACHE.set(specInfo.spec, validator);
            validator.validate(req);
        }
    }
    return next(hyper, req);
};

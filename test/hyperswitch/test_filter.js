"use strict";

var P = require('bluebird');

module.exports = (hyper, req, next, options, specInfo) => {
    return P.resolve({
        status: 200,
        body: 'From Filter'
    });
};
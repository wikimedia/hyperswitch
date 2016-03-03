"use strict";

var P = require('bluebird');

module.exports = function(hyper, req, next, options, specInfo) {
    return P.resolve({
        status: 200,
        body: 'From Filter'
    });
};
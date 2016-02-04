"use strict";

require('core-js/shim');

module.exports = require('./lib/server');
Object.assign(module.exports, require('./lib/exports'));
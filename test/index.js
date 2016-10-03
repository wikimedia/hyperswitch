'use strict';


// Run jshint as part of normal testing
require('mocha-jshint')();
// Run jscs as part of normal testing
require('mocha-jscs')();
// Run eslint as part of normal testing
require('mocha-eslint')([ './lib', 'index.js' ]);

'use strict';

var ServiceRunner = require('service-runner');
var fs        = require('fs');
var yaml      = require('js-yaml');
var P         = require('bluebird');

var Server = function (configPath) {
    this._configPath = configPath;
    this._config = this._loadConfig();
    this._config.num_workers = 0;
    this._config.logging = {
        name: 'hyperswitch-tests',
        level: 'fatal',
        streams: [{ type: 'stdout'}]
    };
    this._runner = new ServiceRunner();
};

Server.prototype._loadConfig = function() {
    return yaml.safeLoad(fs.readFileSync(this._configPath).toString());
};

Server.prototype.start = function() {
    var self = this;
    self.port = self._config.services[0].conf.port;
    self.hostPort = 'http://localhost:' + self.port;
    return self._runner.start(self._config);
};

Server.prototype.stop = function() {
    var self = this;
    return self._runner.stop();
};

module.exports = Server;

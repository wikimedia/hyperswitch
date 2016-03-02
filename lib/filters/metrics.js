"use strict";

module.exports = function(hyper, req, next, options, specInfo) {
    if (!hyper.metrics) {
        return next(hyper, req);
    }

    // Remove the /{domain}/ prefix, as it's not very useful in stats
    var statName = specInfo.path.replace(/\/[^\/]+\//, '') + '.'
                    + req.method.toUpperCase() + '.';
    // Normalize invalid chars
    statName = hyper.metrics.normalizeName(statName);
    // Start timer
    var startTime = Date.now();

    return next(hyper, req).then(function(res) {
        // Record request metrics & log
        var statusClass = Math.floor(res.status / 100) + 'xx';
        hyper.metrics.endTiming([
            statName + res.status,
            statName + statusClass,
            statName + 'ALL'
        ], startTime);
        return res;
    },
    function(err) {
        var statusClass = '5xx';
        if (err && err.status) {
            statusClass = Math.floor(err.status / 100) + 'xx';
        }
        hyper.metrics.endTiming([
            statName + err.status,
            statName + statusClass,
            statName + 'ALL',
        ], startTime);
        throw err;
    });
};
"use strict";

module.exports = (hyper, req, next, options, specInfo) => {
    if (!hyper.metrics) {
        return next(hyper, req);
    }

    // Remove the /{domain}/ prefix, as it's not very useful in stats
    let statName = `${specInfo.path.replace(/\/[^/]+\//, '')}.${
        req.method.toUpperCase()}.`;
    // Normalize invalid chars
    statName = hyper.metrics.normalizeName(statName);
    // Start timer
    const startTime = Date.now();

    return next(hyper, req).then((res) => {
        // Record request metrics & log
        const statusClass = `${Math.floor(res.status / 100)}xx`;
        hyper.metrics.endTiming([
            statName + res.status,
            statName + statusClass,
            `${statName}ALL`
        ], startTime);
        return res;
    },
    (err) => {
        let statusClass = '5xx';
        if (err && err.status) {
            statusClass = `${Math.floor(err.status / 100)}xx`;
        }
        hyper.metrics.endTiming([
            statName + err.status,
            statName + statusClass,
            `${statName}ALL`,
        ], startTime);
        throw err;
    });
};

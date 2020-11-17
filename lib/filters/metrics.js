'use strict';

function emitMetric(hyper, req, res, specInfo, startTime) {
    let statusCode = 'unknown';
    if (res && res.status) {
        statusCode = res.status;
    }
    hyper.metrics.makeMetric({
        type: 'Histogram',
        name: 'router',
        prometheus: {
            name: 'hyperswitch_router_duration_seconds',
            help: 'hyperswitch router duration',
            staticLabels: hyper.metrics.getServiceLabel(),
            buckets: [0.01, 0.05, 0.1, 0.3, 1]
        },
        labels: {
            names: ['request_class', 'path', 'method', 'status'],
            omitLabelNames: true
        }
    }).endTiming(startTime,
        [hyper.requestClass,
            // Remove the /{domain}/ prefix, as it's not very useful in stats
            specInfo.path.replace(/\/[^/]+\//, ''),
            req.method.toUpperCase(), statusCode]);
}

module.exports = (hyper, req, next, options, specInfo) => {
    if (!hyper.metrics) {
        return next(hyper, req);
    }
    // Start timer
    const startTime = Date.now();
    return next(hyper, req).then((res) => {
        // Record request metrics & log
        emitMetric(hyper, req, res, specInfo, startTime);
        return res;
    },
    (err) => {
        emitMetric(hyper, req, err, specInfo, startTime);
        throw err;
    });
};

"use strict";

const P = require('bluebird');
const fs = P.promisifyAll(require('fs'));
const path = require('path');
// Swagger-ui helpfully exporting the absolute path of its dist directory
const docRoot = `${require('swagger-ui').dist}/`;
const HTTPError = require('./exports').HTTPError;

function staticServe(hyper, req) {
    const reqPath = req.query.path;

    const filePath = path.join(docRoot, reqPath);

    // Disallow relative paths.
    // Test relies on docRoot ending on a slash.
    if (filePath.substring(0, docRoot.length) !== docRoot) {
        throw new Error("Invalid path.");
    }

    return fs.readFileAsync(filePath)
    .then((body) => {
        if (reqPath === '/index.html') {
            // Rewrite the HTML to use a query string
            const cfg = hyper.config;
            body = body.toString()
                .replace(/((?:src|href)=['"])/g, '$1?path=')
                // Some self-promotion
                .replace(/<a id="logo".*?<\/a>/,
                    `<a id="logo" href="${cfg.ui_url}">${cfg.ui_name}</a>`)
                .replace(/<title>[^<]*<\/title>/, `<title>${cfg.ui_title}</title>`)
                // Replace the default url with ours, switch off validation &
                // limit the size of documents to apply syntax highlighting to
                .replace(/docExpansion: "none"/, 'docExpansion: "list", '
                    + 'validatorUrl: null, '
                    + 'highlightSizeThreshold: 10000')
                .replace(/ url: url,/, 'url: "?spec",');
        }

        let contentType = 'text/html';
        if (/\.js$/.test(reqPath)) {
            contentType = 'text/javascript';
            body = body.toString()
                .replace(/underscore-min\.map/, '?path=lib/underscore-min.map');
        } else if (/\.png$/.test(reqPath)) {
            contentType = 'image/png';
        } else if (/\.map$/.test(reqPath)) {
            contentType = 'application/json';
        } else if (/\.ttf$/.test(reqPath)) {
            contentType = 'application/x-font-ttf';
        } else if (/\.css$/.test(reqPath)) {
            contentType = 'text/css';
            body = body.toString().replace(/\.\.\/(images|fonts)\//g, '?path=$1/');
        }
        return P.resolve({
            status: 200,
            headers: {
                'content-type': contentType,
                'content-security-policy': "default-src 'none'; " +
                    "script-src 'self' 'unsafe-inline'; connect-src *; " +
                    "style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self';"
            },
            body
        });
    })
    .catch({ code: 'ENOENT' }, () => {
        return new HTTPError({
            status: 404,
            body: {
                type: 'not_found',
                title: 'Not found.'
            }
        });
    });
}

module.exports = staticServe;

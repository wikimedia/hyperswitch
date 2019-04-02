'use strict';

const P = require('bluebird');
const fs = P.promisifyAll(require('fs'));
const path = require('path');
// Swagger-ui helpfully exporting the absolute path of its dist directory
const docRoot = `${require('swagger-ui-dist').getAbsoluteFSPath()}/`;
const HTTPError = require('./exports').HTTPError;

function staticServe(hyper, req, docBasePath) {
    const reqPath = req.query.path;

    const filePath = path.join(docRoot, reqPath);

    // Disallow relative paths.
    // Test relies on docRoot ending on a slash.
    if (filePath.substring(0, docRoot.length) !== docRoot) {
        throw new Error('Invalid path.');
    }

    return fs.readFileAsync(filePath)
    .then((body) => {
        if (reqPath === '/index.html') {
            // Rewrite the HTML to use a query string
            const cfg = hyper.config;
            const css = `
                /* Removes Swagger's image from the header bar */
                .topbar-wrapper .link img {
                    display: none;
                }
                /* Adds the application's name in the header bar */
                .topbar-wrapper .link::after {
                    content: "${cfg.ui_name}";
                }
                /* Removes input field and explore button from header bar */
                .swagger-ui .topbar .download-url-wrapper {
                    display: none;
                }
                /* Modifies the font in the information area */
                .swagger-ui .info li, .swagger-ui .info p, .swagger-ui .info table, .swagger-ui .info a {
                    font-size: 16px;
                    line-height: 1.4em;
                }
                /* Removes authorize button and section */
                .scheme-container {
                    display: none
                }
            `;
            body = body.toString()
                .replace(/((?:src|href)=['"])/g, '$1?path=')
                // Some self-promotion
                .replace(/<\/style>/, `${css}\n  </style>`)
                .replace(/<title>[^<]*<\/title>/, `<title>${cfg.ui_title}</title>`)
                // Replace the default url with ours, switch off validation &
                // limit the size of documents to apply syntax highlighting to
                .replace(/dom_id: '#swagger-ui'/, 'dom_id: "#swagger-ui", ' +
                    'docExpansion: "none", defaultModelsExpandDepth: -1, validatorUrl: null, displayRequestDuration: true')
                .replace(/"https:\/\/petstore.swagger.io\/v2\/swagger.json"/,
                    `"${docBasePath}/?spec"`);
        }

        let contentType = 'text/html';
        if (/\.js$/.test(reqPath)) {
            contentType = 'text/javascript';
            body = body.toString()
                .replace(/underscore-min\.map/, '?path=lib/underscore-min.map')
                .replace(/sourceMappingURL=/, 'sourceMappingURL=/?path=');
        } else if (/\.png$/.test(reqPath)) {
            contentType = 'image/png';
        } else if (/\.map$/.test(reqPath)) {
            contentType = 'application/json';
        } else if (/\.ttf$/.test(reqPath)) {
            contentType = 'application/x-font-ttf';
        } else if (/\.css$/.test(reqPath)) {
            contentType = 'text/css';
            body = body.toString()
                .replace(/\.\.\/(images|fonts)\//g, '?path=$1/')
                .replace(/sourceMappingURL=/, 'sourceMappingURL=/?path=');
        }
        return P.resolve({
            status: 200,
            headers: {
                'content-type': contentType,
                'content-security-policy': "default-src 'none'; " +
                    "script-src 'self' 'unsafe-inline'; connect-src *; " +
                    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';"
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

"use strict";

var P = require('bluebird');
var yaml = require('js-yaml');
var fs = P.promisifyAll(require('fs'));
var handlerTemplate = require('./handlerTemplate');
var swaggerRouter = require('swagger-router');
var path = require('path');

var Node = swaggerRouter.Node;
var Template = swaggerRouter.Template;
var URI = swaggerRouter.URI;
var SwaggerRouter = swaggerRouter.Router;


/**
 *
 * @param {object} init
 *      - {string} prefixPath: The prefix within the current API scope
 *      - {object} specRoot, the root of the merged spec for the current API
 *      scope
 *      - {object} globals, global config data / options
 *      - {object} operations, Object mapping operationId -> handler
 */
function ApiScope(init) {
    init = init || {};
    this.specRoot = init.specRoot;
    this.globals = init.globals || {};
    this.operations = init.operations || {};
    this.prefixPath = init.prefixPath || '';
    this.rootScope = init.rootScope;
}

ApiScope.prototype.makeChild = function(overrides) {
    var newScope = new ApiScope(this);
    Object.assign(newScope, overrides);
    return newScope;
};


function Router(options) {
    this._options = options || {};
    this._nodes = new Map();
    this._modules = new Map();
    this.router = new SwaggerRouter();
}

// Extend an existing route tree with a new path by walking the existing tree
// and inserting new subtrees at the desired location.
Router.prototype._buildPath = function route(node, path, value) {
    var params = {};
    for (var i = 0; i < path.length; i++) {
        var segment = path[i];
        var nextNode = node.getChild(segment, params);
        if (!nextNode) {
            nextNode = new Node();
            node.setChild(segment, nextNode);
            if (segment.modifier === '/') {
                // Set the value for each optional path segment ({/foo})
                node.value = value;
            }
            node = nextNode;
        } else {
            node = nextNode;
        }
    }
    return node;
};

/**
 * Tries to require the module supplied in the configuration
 */
Router.prototype._requireModule = function(modName) {
    var self = this;
    var opts = arguments[1] || { mod: modName, baseTried: false, modsTried: false };
    try {
        return require(modName);
    } catch (e) {
        if (e.message !== "Cannot find module '" + modName + "'") {
            throw e;
        }
        if (/^\//.test(opts.mod) || (opts.baseTried && opts.modsTried)) {
            // we have a full path here which can't be required, or we tried
            // all of the possible combinations, so bail out
            e.moduleName = opts.mod;
            throw e;
        } else {
            // This might be a relative path, convert it to absolute and try again
            if (!opts.baseTried) {
                // first, try to load it from the app's base path
                opts.baseTried = true;
                modName = path.join(self._options.appBasePath, opts.mod);
            } else {
                // then, retry its node_modules directory
                opts.modsTried = true;
                modName = path.join(self._options.appBasePath, 'node_modules', opts.mod);
            }
            return self._requireModule(modName, opts);
        }
    }
};

Router.prototype._expandOptions = function(def, globals) {
    // Expand options in the parent context, so that config options can be
    // passed down the chain.
    var options = {};
    if (def.options) {
        // Protect "templates" property from expansion.
        var templates = def.options.templates;
        delete def.options.templates;
        options = new Template(def.options).expand(globals) || {};
        // Add the original "templates" property back.
        options.templates = templates;
    }

    // Append the log property to module options, if it is not present
    if (!options.log) {
        options.log = this._options.log || function() {};
    }
    return options;
};

Router.prototype._loadFilter = function(filterDef, globals, method) {
    if (filterDef.type === 'default') {
        filterDef.path = __dirname + '/filters/' + filterDef.name + '.js';
    }

    var options = this._expandOptions(filterDef, globals);
    options._cache = {};

    return {
        filter: this._requireModule(filterDef.path),
        options: options,
        method: method
    };
};

Router.prototype._loadRouteFilters = function(node, spec, scope, method) {
    var self = this;
    var filtersDef = spec['x-route-filters'];
    if (Array.isArray(filtersDef)) {
        var filters = filtersDef.map(function(filterDef) {
            return self._loadFilter(filterDef, scope.globals, method);
        });
        node.value = node.value || {};
        node.value.filters = [].concat(node.value.filters || [], filters);
    }
};

/**
 * Load and initialize a module
 */
Router.prototype._loadModule = function(modDef, globals) {

    var self = this;

    // First, check if we have a copy of this module in the cache, so that we
    // can share it.
    var cachedModule = self._modules.get(modDef);
    if (cachedModule && cachedModule._parentGlobals === globals) {
        return P.resolve(cachedModule);
    }

    var loadPath;

    var modType = modDef.type;
    if (modDef.path && !modType) {
        // infer the type from the path
        if (/\.js$/.test(modDef.path)) {
            modType = 'file';
        } else if (/\.yaml$/.test(modDef.path)) {
            modType = 'spec';
        }
    } else if (modDef.spec && !modType) {
        modType = 'inline';
    }

    // Determine the module's load path
    switch (modType) {
        case 'file':
            loadPath = modDef.path;
            break;
        case 'spec':
            if (modDef.path && /^\//.test(modDef.path)) {
                // Absolute path
                loadPath = modDef.path;
            } else if (modDef.path) {
                // Relative path or missing
                loadPath = this._options.appBasePath + '/' + modDef.path;
            } else {
                throw new Error('Unknown module path');
            }
            break;
        case 'npm':
            loadPath = modDef.name;
            break;
        case 'inline':
            // Nothing to do here
            break;
        default:
            throw new Error('unknown module type '
                + modDef.type + ' (for module ' + (modDef.name || modDef) + ').');
    }

    var options = this._expandOptions(modDef, globals);

    function constructModule(spec) {
        var mod = {
            spec: spec,
            globals: { options: options, log: options.log },
            // Needed to check cache validity.
            _parentGlobals: globals,
        };
        self._modules.set(modDef, mod);
        return mod;
    }

    if (modType === 'spec') {
        return fs.readFileAsync(loadPath)
        .then(function(specSrc) {
            var spec = yaml.safeLoad(specSrc);
            return constructModule(yaml.safeLoad(specSrc));
        });
    } else if (modType === 'inline') {
        return P.resolve(constructModule(modDef.spec));
    } else {
        // Let the error propagate in case the module cannot be loaded
        var modObj = self._requireModule(loadPath);
        // Call if it's a function
        if (modObj instanceof Function) {
            modObj = modObj(options);
        }
        if (!(modObj instanceof P)) {
            // Wrap
            modObj = P.resolve(modObj);
        }
        return modObj.then(function(mod) {
            if (!mod.operations && !mod.globals) {
                throw new Error('No operations exported by module ' + loadPath);
            }
            if (!mod.globals) { mod.globals = {}; }
            mod.globals.log = options.log;
            // Needed to check cache validity.
            mod._parentGlobals = globals;
            self._modules.set(modDef, mod);
            return mod;
        });
    }
};

Router.prototype._loadModules = function(node, hyperModules, scope, parentSegment) {
    var self = this;

    if (!Array.isArray(hyperModules)) {
        throw new Error('Invalid modules definition ' + JSON.stringify(hyperModules));
    }

    return P.each(hyperModules, function(moduleDefinition) {
        // Share modules
        return self._loadModule(moduleDefinition, scope.globals)
        .then(function(module) {
            if (module.resources) {
                // Resources array is shared between nodes,
                // so need to modify the array, not create a new with concat
                module.resources.forEach(function(res) {
                    node.value.resources.push(res);
                });
            }
            var childScope = scope.makeChild({
                operations: module.operations,
                globals: module.globals,
            });
            return self._handleSwaggerSpec(node, module.spec, childScope, parentSegment);
        });
    });
};

/**
 * Register paths, handlers & other data in the node & the specRoot.
 * @param {Node}
 * @param {object} pathspec
 * @param {ApiScope} scope
 */
Router.prototype._registerMethods = function(node, pathspec, scope) {
    var self = this;

    Object.keys(pathspec).forEach(function(methodName) {
        if (/^x-/.test(methodName)) {
            return;
        }
        var method = pathspec[methodName];
        var specPaths = scope.specRoot.paths;
        // Insert the method spec into the global merged spec
        if (method && !method['x-hidden']
                && (!specPaths[scope.prefixPath]
                    || !specPaths[scope.prefixPath][methodName])) {
            // Register the path in the specRoot
            if (!specPaths[scope.prefixPath]) {
                specPaths[scope.prefixPath] = {};
            }
            specPaths[scope.prefixPath][methodName] = method;
        }

        if (node.value.methods.hasOwnProperty(methodName)) {
            var e = new Error('Trying to re-define existing method '
                + node.value.path + ':' + methodName);
            e.pathspec = pathspec;
            throw e;
        }

        // Check and add method-level security specs
        if (Array.isArray(method.security)) {
            node.value.security = method.security.map(function(item) {
                return {
                    value: item,
                    method: methodName
                };
            }).concat(node.value.security || []);
        }

        self._loadRouteFilters(node, method, scope, methodName);

        var backendSetup = method['x-setup-handler'];
        if (backendSetup) {
            Array.prototype.push.apply(node.value.resources,
                handlerTemplate.parseSetupConfig(backendSetup));
        }

        var reqHandler;
        var backendRequest = method['x-request-handler'];
        if (backendRequest) {
            reqHandler = handlerTemplate.createHandler(backendRequest, {
                globals: node.value.globals,
            });
        } else if (method.operationId) {
            reqHandler = scope.operations[method.operationId];
            if (!reqHandler) {
                throw new Error('No known handler associated with operationId '
                    + method.operationId);
            }
        }

        if (reqHandler) {
            node.value.methods[methodName] = reqHandler;
            node.value.methods[methodName].spec = method;
        }
    });
};

Router.prototype._createNewApiRoot = function(node, spec, scope) {
    var specRoot = Object.assign({}, spec);
    // Make sure the spec has the standard properties set up.
    specRoot.swagger = spec.swagger || '2.0';
    specRoot.definitions = spec.definitions || {};
    specRoot.securityDefinitions = spec.securityDefinitions || {};
    specRoot['x-default-params'] = spec['x-default-params'] || {};
    specRoot.tags = spec.tags || [];

    // Reset paths. These are going to be built up during path setup.
    specRoot.paths = {};
    specRoot.basePath = scope.prefixPath;

    node.setChild('', new Node({
        specRoot: specRoot,
        methods: {},
        path: specRoot.basePath + '/',
        globals: node.value && node.value.globals || scope.globals
    }));

    return scope.makeChild({
        specRoot: specRoot,
        prefixPath: ''
    });
};
/**
 * Process a Swagger path spec object
 */
Router.prototype._handleSwaggerPathSpec = function(node, pathspec, scope, parentSegment) {
    var self = this;
    if (!pathspec) {
        return P.resolve();
    }

    var loaderPromise = P.resolve();

    // Load modules
    var hsModules = pathspec['x-modules'];
    if (hsModules) {
        loaderPromise = loaderPromise.then(function() {
            return self._loadModules(node, hsModules, scope, parentSegment);
        });
    }

    var security = pathspec.security;
    if (Array.isArray(security)) {
        node.value.security = security.map(function(item) {
            return { value: item };
        }).concat(node.value.security || []);
    }

    self._loadRouteFilters(node, pathspec, scope);

    return loaderPromise
    // Process HTTP method stanzas ('get', 'put' etc)
    .then(function() {
        return self._registerMethods(node, pathspec, scope);
    });
};


/**
 * @param {object} spec, the spec potentially containing a paths object.
 * @param {Node} rootNode, the node all paths are branching from.
 * @param {ApiScope} scope
 * @return {Promise<void>}
 **/
Router.prototype._handlePaths = function(rootNode, spec, scope) {
    var self = this;
    var paths = spec.paths;
    if (!paths || !Object.keys(paths).length) {
        // No paths here, nothing to do
        return P.resolve();
    }

    // Handle paths
    // Sequence the build process with `.each` to avoid race conditions
    // while building the tree.
    return P.each(Object.keys(paths), function(pathPattern) {
        var pathSpec = paths[pathPattern];
        var pathURI = new URI(pathPattern, {}, true);
        var path = pathURI.path;

        var childScope = scope.makeChild({
            prefixPath: scope.prefixPath + pathURI.toString('simplePattern'),
        });

        // Create a value object early, so that _buildPath can set up a reference
        // to it for optional path segments.
        var value = {
            specRoot: childScope.specRoot,
            path: undefined,
            methods: {},
            resources: [],
            globals: scope.globals || {},
        };

        // Expected to return
        // - rootNode for single-element path
        // - a subnode for longer paths
        var branchNode = self._buildPath(rootNode, path.slice(0, path.length - 1), value);

        // Check if we can share the subtree for the pathspec.
        var subtree = self._nodes.get(pathSpec);
        var specPromise;
        if (!subtree || subtree._parentGlobals !== childScope.globals) {
            var segment = path[path.length - 1];

            // Check if the subtree already exists, which can happen when
            // specs are overlapping.
            subtree = branchNode.getChild(segment, {});
            if (!subtree) {
                // Build a new subtree
                subtree = new Node();
                // Set up our specific value object
                subtree.value = value;
                value.path = childScope.specRoot.basePath + childScope.prefixPath;
                value.methods = {};
                // XXX: Set ACLs and other value properties for path
                // subtree.value.acls = ...;

                if (segment.modifier === '+') {
                    // Set up a recursive match and end the traversal
                    subtree.setChild(segment, subtree);
                } else if (segment.modifier === '/') {
                    // Since this path segment is optional, the parent node
                    // has the same value.
                    // FIXME: Properly handle the case where paths overlap, as
                    // in /foo and /foo{/bar}, possibly by merging methods
                    // after initializing them with _handleSwaggerPathSpec().
                    branchNode.value = value;
                }

                // Path spec with only x-modules & no methods: Forward globals
                // & set up caching.
                if (Object.keys(pathSpec).length === 1 && pathSpec['x-modules']) {
                    subtree._parentGlobals = childScope.globals;
                    self._nodes.set(pathSpec, subtree);
                }
            }

            // Handle the path spec
            specPromise = self._handleSwaggerPathSpec(subtree, pathSpec, childScope, segment);
        } else {
            // Share the subtree.
            var origSubtree = subtree;
            subtree = subtree.clone();
            subtree.value = value;
            // Copy over the remaining value properties.
            Object.assign(subtree.value, origSubtree.value);
            subtree.value.path = childScope.specRoot.basePath + childScope.prefixPath;
            specPromise = P.resolve();
        }
        branchNode.setChild(path[path.length - 1], subtree);
        return specPromise;
    });
};

/**
 * Process a Swagger spec.
 * @param {Node} node
 * @param {object} spec
 * @param {ApiScope} scope
 * @return {Promise<void>}
 */
Router.prototype._handleSwaggerSpec = function(node, spec, scope, parentSegment) {
    var self = this;

    if (!parentSegment || parentSegment.name === 'api') {
        var listingNode = node.getChild('');
        if (listingNode) {
            scope = scope.makeChild({
                specRoot: listingNode.value.specRoot,
                prefixPath: '',
            });
        } else {
            // This is first time we've seen this api, so create new specRoot for it.
            scope = this._createNewApiRoot(node, spec, scope);
        }
        scope.rootScope = scope;
    }

    // Merge in definitions & securityDefinitions from the spec.
    // TODO: Do we need a clone here? Is it okay if those definitions are
    // added to the higher level spec?
    Object.assign(scope.specRoot.definitions, spec.definitions);
    Object.assign(scope.specRoot.securityDefinitions, spec.securityDefinitions);
    scope.specRoot.tags = scope.specRoot.tags.concat(spec.tags || []);

    this._loadRouteFilters(node, spec, scope);

    var loadPromise = self._handlePaths(node, spec, scope);
    // Also support spec-level modules.
    var xModules = spec['x-modules'];
    if (xModules) {
        loadPromise = loadPromise.then(function() {
            return self._loadModules(node, xModules, scope, parentSegment);
        });
    }
    return loadPromise;
};

/**
 * Set up resources (ex: dynamic storage like tables) by traversing the tree &
 * performing the requests specified in resource stanzas. Default HTTP method
 * is 'put'.
 *
 * Any error during resource creation (status code >= 400) will abort startup
 * after logging the error as a fatal.
 */
Router.prototype.handleResources = function(hyper) {
    return this.tree.visitAsync(function(value, path) {
        if (value && Array.isArray(value.resources) && value.resources.length > 0) {
            return P.each(value.resources, function(reqSpec) {
                var reqTemplate = new Template(reqSpec);
                var req = reqTemplate.expand({
                    request: {
                        params: {
                            domain: path[0]
                        }
                    }
                });
                if (!req.uri) {
                    throw new Error("Missing resource URI in spec for "
                        + JSON.stringify(path));
                }
                req.method = req.method || 'put';
                return hyper.request(req);
            });
        } else {
            return P.resolve();
        }
    });
};

/**
 * Load a new Swagger spec
 *
 * This involves building a tree, initializing modules, merging specs &
 * initializing resources: Basically the entire app startup.
 */
Router.prototype.loadSpec = function(spec, hyper) {
    var self = this;
    var rootNode = new Node();
    var scope = new ApiScope({
        globals: {
            options: hyper.config
        }
    });

    // First load default request filters. The order of the stack matters.
    // TODO: Do that in a cleaner way
    spec['x-route-filters'] = [{
            type: 'default', name: 'metrics'
        },
        {
            type: 'default', name: 'validator'
        }
    ].concat(spec['x-route-filters'] || []);
    return self._handleSwaggerSpec(rootNode, spec, scope)
    .then(function() {
        (spec['x-request-filters'] || []).forEach(function(filterDef) {
            hyper._requestFilters = hyper._requestFilters || [];
            hyper._requestFilters.push(self._loadFilter(filterDef, { options: hyper.config }));
        });
        (spec['x-sub-request-filters'] || []).forEach(function(filterDef) {
            hyper._subRequestFilters = hyper._subRequestFilters || [];
            hyper._subRequestFilters.push(self._loadFilter(filterDef, { options: hyper.config }));
        });
        // Only set the tree after loading everything
        self.tree = rootNode;
        self.router.setTree(rootNode);
        return self.handleResources(hyper);
    })
    .then(function() {
        return self;
    });
};

/**
 * Resolve an URI to a value object
 *
 * Main request routing entry point.
 * @param {URI|String} uri URI object
 * @return {object} match:
 * - @prop {object} value:
 *   - @prop {object} methods: handlers for methods like get, post etc
 *   - @prop {string} path: path to this tree node
 * - @prop {object} params: Object with path parameters and optionally `_ls`
 *   for URIs ending in `/`.
 */
Router.prototype.route = function(uri) {
    return this.router.lookup(uri);
};

module.exports = Router;

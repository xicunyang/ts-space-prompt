"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib='webworker.importscripts' />
/// <reference lib='webworker' />
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const sync_api_client_1 = require("@vscode/sync-api-client");
const browser_1 = require("@vscode/sync-api-common/browser");
const path_1 = require("path");
const ts = __importStar(require("typescript/lib/tsserverlibrary"));
const vscode_uri_1 = require("vscode-uri");
const typingsInstaller_1 = __importDefault(require("./typingsInstaller"));
// GLOBALS
const watchFiles = new Map();
const watchDirectories = new Map();
let session;
const projectRootPaths = new Map();
// END GLOBALS
// BEGIN misc internals
const indent = ts.server.indent;
const setSys = ts.setSys;
const combinePaths = ts.combinePaths;
const byteOrderMarkIndicator = '\uFEFF';
const matchFiles = ts.matchFiles;
const generateDjb2Hash = ts.generateDjb2Hash;
// End misc internals
function fromResource(extensionUri, uri) {
    if (uri.scheme === extensionUri.scheme
        && uri.authority === extensionUri.authority
        && uri.path.startsWith(extensionUri.path + '/dist/browser/typescript/lib.')
        && uri.path.endsWith('.d.ts')) {
        return uri.path;
    }
    return `/${uri.scheme}/${uri.authority}${uri.path}`;
}
function updateWatch(event, uri, extensionUri) {
    const kind = toTsWatcherKind(event);
    const path = fromResource(extensionUri, uri);
    const fileWatcher = watchFiles.get(path);
    if (fileWatcher) {
        fileWatcher.callback(path, kind);
        return;
    }
    for (const watch of Array.from(watchDirectories.keys()).filter(dir => path.startsWith(dir))) {
        watchDirectories.get(watch).callback(path);
        return;
    }
    console.error(`no watcher found for ${path}`);
}
function toTsWatcherKind(event) {
    if (event === 'create') {
        return ts.FileWatcherEventKind.Created;
    }
    else if (event === 'change') {
        return ts.FileWatcherEventKind.Changed;
    }
    else if (event === 'delete') {
        return ts.FileWatcherEventKind.Deleted;
    }
    throw new Error(`Unknown event: ${event}`);
}
class AccessOutsideOfRootError extends Error {
    constructor(filepath, projectRootPaths) {
        super(`Could not read file outside of project root ${filepath}`);
        this.filepath = filepath;
        this.projectRootPaths = projectRootPaths;
    }
}
function createServerHost(extensionUri, logger, apiClient, args, fsWatcher, enabledExperimentalTypeAcquisition) {
    const currentDirectory = '/';
    const fs = apiClient?.vscode.workspace.fileSystem;
    let watchId = 0;
    // Legacy web
    const memoize = ts.memoize;
    const ensureTrailingDirectorySeparator = ts.ensureTrailingDirectorySeparator;
    const getDirectoryPath = ts.getDirectoryPath;
    const directorySeparator = ts.directorySeparator;
    const executingFilePath = findArgument(args, '--executingFilePath') || location + '';
    const getExecutingDirectoryPath = memoize(() => memoize(() => ensureTrailingDirectorySeparator(getDirectoryPath(executingFilePath))));
    const getWebPath = (path) => path.startsWith(directorySeparator) ? path.replace(directorySeparator, getExecutingDirectoryPath()) : undefined;
    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();
    const log = (level, message, data) => {
        if (logger.hasLevel(level)) {
            logger.info(message + (data ? ' ' + JSON.stringify(data) : ''));
        }
    };
    const logNormal = log.bind(null, ts.server.LogLevel.normal);
    const logVerbose = log.bind(null, ts.server.LogLevel.verbose);
    const noopWatcher = { close() { } };
    return {
        watchFile(path, callback, pollingInterval, options) {
            if (looksLikeLibDtsPath(path)) { // We don't support watching lib files on web since they are readonly
                return noopWatcher;
            }
            console.log('watching file:', path);
            logVerbose('fs.watchFile', { path });
            let uri;
            try {
                uri = toResource(path);
            }
            catch (e) {
                console.error(e);
                return noopWatcher;
            }
            watchFiles.set(path, { path, callback, pollingInterval, options });
            const watchIds = [++watchId];
            fsWatcher.postMessage({ type: 'watchFile', uri: uri, id: watchIds[0] });
            if (enabledExperimentalTypeAcquisition && looksLikeNodeModules(path)) {
                watchIds.push(++watchId);
                fsWatcher.postMessage({ type: 'watchFile', uri: mapUri(uri, 'vscode-node-modules'), id: watchIds[1] });
            }
            return {
                close() {
                    logVerbose('fs.watchFile.close', { path });
                    watchFiles.delete(path);
                    for (const id of watchIds) {
                        fsWatcher.postMessage({ type: 'dispose', id });
                    }
                }
            };
        },
        watchDirectory(path, callback, recursive, options) {
            logVerbose('fs.watchDirectory', { path });
            let uri;
            try {
                uri = toResource(path);
            }
            catch (e) {
                console.error(e);
                return noopWatcher;
            }
            watchDirectories.set(path, { path, callback, recursive, options });
            const watchIds = [++watchId];
            fsWatcher.postMessage({ type: 'watchDirectory', recursive, uri, id: watchId });
            return {
                close() {
                    logVerbose('fs.watchDirectory.close', { path });
                    watchDirectories.delete(path);
                    for (const id of watchIds) {
                        fsWatcher.postMessage({ type: 'dispose', id });
                    }
                }
            };
        },
        setTimeout(callback, ms, ...args) {
            return setTimeout(callback, ms, ...args);
        },
        clearTimeout(timeoutId) {
            clearTimeout(timeoutId);
        },
        setImmediate(callback, ...args) {
            return this.setTimeout(callback, 0, ...args);
        },
        clearImmediate(timeoutId) {
            this.clearTimeout(timeoutId);
        },
        importPlugin: async (root, moduleName) => {
            const packageRoot = combinePaths(root, moduleName);
            let packageJson;
            try {
                const packageJsonResponse = await fetch(combinePaths(packageRoot, 'package.json'));
                packageJson = await packageJsonResponse.json();
            }
            catch (e) {
                return { module: undefined, error: new Error(`Could not load plugin. Could not load 'package.json'.`) };
            }
            const browser = packageJson.browser;
            if (!browser) {
                return { module: undefined, error: new Error(`Could not load plugin. No 'browser' field found in package.json.`) };
            }
            const scriptPath = combinePaths(packageRoot, browser);
            try {
                const { default: module } = await Promise.resolve(`${scriptPath}`).then(s => __importStar(require(s)));
                return { module, error: undefined };
            }
            catch (e) {
                return { module: undefined, error: e };
            }
        },
        args,
        newLine: '\n',
        useCaseSensitiveFileNames: true,
        write: s => {
            apiClient?.vscode.terminal.write(s);
        },
        writeOutputIsTTY() {
            return true;
        },
        readFile(path) {
            logVerbose('fs.readFile', { path });
            if (!fs) {
                const webPath = getWebPath(path);
                if (webPath) {
                    const request = new XMLHttpRequest();
                    request.open('GET', webPath, /* asynchronous */ false);
                    request.send();
                    return request.status === 200 ? request.responseText : undefined;
                }
                else {
                    return undefined;
                }
            }
            let uri;
            try {
                uri = toResource(path);
            }
            catch (e) {
                return undefined;
            }
            let contents;
            try {
                // We need to slice the bytes since we can't pass a shared array to text decoder
                contents = fs.readFile(uri);
            }
            catch (error) {
                if (!enabledExperimentalTypeAcquisition) {
                    return undefined;
                }
                try {
                    contents = fs.readFile(mapUri(uri, 'vscode-node-modules'));
                }
                catch (e) {
                    return undefined;
                }
            }
            return textDecoder.decode(contents.slice());
        },
        getFileSize(path) {
            logVerbose('fs.getFileSize', { path });
            if (!fs) {
                throw new Error('not supported');
            }
            const uri = toResource(path);
            let ret = 0;
            try {
                ret = fs.stat(uri).size;
            }
            catch (_error) {
                if (enabledExperimentalTypeAcquisition) {
                    try {
                        ret = fs.stat(mapUri(uri, 'vscode-node-modules')).size;
                    }
                    catch (_error) {
                    }
                }
            }
            return ret;
        },
        writeFile(path, data, writeByteOrderMark) {
            logVerbose('fs.writeFile', { path });
            if (!fs) {
                throw new Error('not supported');
            }
            if (writeByteOrderMark) {
                data = byteOrderMarkIndicator + data;
            }
            let uri;
            try {
                uri = toResource(path);
            }
            catch (e) {
                return;
            }
            const encoded = textEncoder.encode(data);
            try {
                fs.writeFile(uri, encoded);
                const name = (0, path_1.basename)(uri.path);
                if (uri.scheme !== 'vscode-global-typings' && (name === 'package.json' || name === 'package-lock.json' || name === 'package-lock.kdl')) {
                    fs.writeFile(mapUri(uri, 'vscode-node-modules'), encoded);
                }
            }
            catch (error) {
                console.error('fs.writeFile', { path, error });
            }
        },
        resolvePath(path) {
            return path;
        },
        fileExists(path) {
            logVerbose('fs.fileExists', { path });
            if (!fs) {
                const webPath = getWebPath(path);
                if (!webPath) {
                    return false;
                }
                const request = new XMLHttpRequest();
                request.open('HEAD', webPath, /* asynchronous */ false);
                request.send();
                return request.status === 200;
            }
            let uri;
            try {
                uri = toResource(path);
            }
            catch (e) {
                return false;
            }
            let ret = false;
            try {
                ret = fs.stat(uri).type === sync_api_client_1.FileType.File;
            }
            catch (_error) {
                if (enabledExperimentalTypeAcquisition) {
                    try {
                        ret = fs.stat(mapUri(uri, 'vscode-node-modules')).type === sync_api_client_1.FileType.File;
                    }
                    catch (_error) {
                    }
                }
            }
            return ret;
        },
        directoryExists(path) {
            logVerbose('fs.directoryExists', { path });
            if (!fs) {
                return false;
            }
            let uri;
            try {
                uri = toResource(path);
            }
            catch (_error) {
                return false;
            }
            let stat = undefined;
            try {
                stat = fs.stat(uri);
            }
            catch (_error) {
                if (enabledExperimentalTypeAcquisition) {
                    try {
                        stat = fs.stat(mapUri(uri, 'vscode-node-modules'));
                    }
                    catch (_error) {
                    }
                }
            }
            if (stat) {
                if (path.startsWith('/https') && !path.endsWith('.d.ts')) {
                    // TODO: Hack, https "file system" can't actually tell what is a file vs directory
                    return stat.type === sync_api_client_1.FileType.File || stat.type === sync_api_client_1.FileType.Directory;
                }
                return stat.type === sync_api_client_1.FileType.Directory;
            }
            else {
                return false;
            }
        },
        createDirectory(path) {
            logVerbose('fs.createDirectory', { path });
            if (!fs) {
                throw new Error('not supported');
            }
            try {
                fs.createDirectory(toResource(path));
            }
            catch (error) {
                logNormal('Error fs.createDirectory', { path, error: error + '' });
            }
        },
        getExecutingFilePath() {
            return currentDirectory;
        },
        getCurrentDirectory() {
            return currentDirectory;
        },
        getDirectories(path) {
            logVerbose('fs.getDirectories', { path });
            return getAccessibleFileSystemEntries(path).directories.slice();
        },
        readDirectory(path, extensions, excludes, includes, depth) {
            logVerbose('fs.readDirectory', { path });
            return matchFiles(path, extensions, excludes, includes, /*useCaseSensitiveFileNames*/ true, currentDirectory, depth, getAccessibleFileSystemEntries, realpath);
        },
        getModifiedTime(path) {
            logVerbose('fs.getModifiedTime', { path });
            if (!fs) {
                throw new Error('not supported');
            }
            const uri = toResource(path);
            let s = undefined;
            try {
                s = fs.stat(uri);
            }
            catch (_e) {
                if (enabledExperimentalTypeAcquisition) {
                    try {
                        s = fs.stat(mapUri(uri, 'vscode-node-modules'));
                    }
                    catch (_e) {
                    }
                }
            }
            return s && new Date(s.mtime);
        },
        deleteFile(path) {
            logVerbose('fs.deleteFile', { path });
            if (!fs) {
                throw new Error('not supported');
            }
            try {
                fs.delete(toResource(path));
            }
            catch (error) {
                logNormal('Error fs.deleteFile', { path, error: error + '' });
            }
        },
        createHash: generateDjb2Hash,
        /** This must be cryptographically secure.
            The browser implementation, crypto.subtle.digest, is async so not possible to call from tsserver. */
        createSHA256Hash: undefined,
        exit() {
            removeEventListener('message', listener);
        },
        realpath,
        base64decode: input => Buffer.from(input, 'base64').toString('utf8'),
        base64encode: input => Buffer.from(input).toString('base64'),
    };
    // For module resolution only. `node_modules` is also automatically mapped
    // as if all node_modules-like paths are symlinked.
    function realpath(path) {
        const isNm = looksLikeNodeModules(path) && !path.startsWith('/vscode-global-typings/');
        // skip paths without .. or ./ or /. And things that look like node_modules
        if (!isNm && !path.match(/\.\.|\/\.|\.\//)) {
            return path;
        }
        let uri = toResource(path);
        if (isNm) {
            uri = mapUri(uri, 'vscode-node-modules');
        }
        const out = [uri.scheme];
        if (uri.authority) {
            out.push(uri.authority);
        }
        for (const part of uri.path.split('/')) {
            switch (part) {
                case '':
                case '.':
                    break;
                case '..':
                    //delete if there is something there to delete
                    out.pop();
                    break;
                default:
                    out.push(part);
            }
        }
        return '/' + out.join('/');
    }
    function getAccessibleFileSystemEntries(path) {
        if (!fs) {
            throw new Error('not supported');
        }
        const uri = toResource(path || '.');
        let entries = [];
        const files = [];
        const directories = [];
        try {
            entries = fs.readDirectory(uri);
        }
        catch (_e) {
            try {
                entries = fs.readDirectory(mapUri(uri, 'vscode-node-modules'));
            }
            catch (_e) {
            }
        }
        for (const [entry, type] of entries) {
            // This is necessary because on some file system node fails to exclude
            // '.' and '..'. See https://github.com/nodejs/node/issues/4002
            if (entry === '.' || entry === '..') {
                continue;
            }
            if (type === sync_api_client_1.FileType.File) {
                files.push(entry);
            }
            else if (type === sync_api_client_1.FileType.Directory) {
                directories.push(entry);
            }
        }
        files.sort();
        directories.sort();
        return { files, directories };
    }
    /**
     * Copied from toResource in typescriptServiceClient.ts
     */
    function toResource(filepath) {
        if (looksLikeLibDtsPath(filepath)) {
            return vscode_uri_1.URI.from({
                scheme: extensionUri.scheme,
                authority: extensionUri.authority,
                path: extensionUri.path + '/dist/browser/typescript/' + filepath.slice(1)
            });
        }
        const uri = filePathToResourceUri(filepath);
        if (!uri) {
            throw new Error(`Could not parse path ${filepath}`);
        }
        // Check if TS is trying to read a file outside of the project root.
        // We allow reading files on unknown scheme as these may be loose files opened by the user.
        // However we block reading files on schemes that are on a known file system with an unknown root
        let allowRead = 'implicit';
        for (const projectRoot of projectRootPaths.values()) {
            if (uri.scheme === projectRoot.scheme) {
                if (uri.toString().startsWith(projectRoot.toString())) {
                    allowRead = 'allow';
                    break;
                }
                // Tentatively block the read but a future loop may allow it
                allowRead = 'block';
            }
        }
        if (allowRead === 'block') {
            throw new AccessOutsideOfRootError(filepath, Array.from(projectRootPaths.keys()));
        }
        return uri;
    }
}
function looksLikeLibDtsPath(filepath) {
    return filepath.startsWith('/lib.') && filepath.endsWith('.d.ts');
}
function looksLikeNodeModules(filepath) {
    return filepath.includes('/node_modules');
}
function filePathToResourceUri(filepath) {
    const parts = filepath.match(/^\/([^\/]+)\/([^\/]*)(?:\/(.+))?$/);
    if (!parts) {
        return undefined;
    }
    const scheme = parts[1];
    const authority = parts[2] === 'ts-nul-authority' ? '' : parts[2];
    const path = parts[3];
    return vscode_uri_1.URI.from({ scheme, authority, path: (path ? '/' + path : path) });
}
class WasmCancellationToken {
    constructor() {
        this.currentRequestId = undefined;
    }
    setRequest(requestId) {
        this.currentRequestId = requestId;
    }
    resetRequest(requestId) {
        if (requestId === this.currentRequestId) {
            this.currentRequestId = undefined;
        }
        else {
            throw new Error(`Mismatched request id, expected ${this.currentRequestId} but got ${requestId}`);
        }
    }
    isCancellationRequested() {
        return this.currentRequestId !== undefined && !!this.shouldCancel && this.shouldCancel();
    }
}
class WorkerSession extends ts.server.Session {
    constructor(host, fs, options, port, logger, hrtime) {
        const cancellationToken = new WasmCancellationToken();
        const typingsInstaller = options.disableAutomaticTypingAcquisition || !fs ? ts.server.nullTypingsInstaller : new typingsInstaller_1.default(host, '/vscode-global-typings/ts-nul-authority/projects');
        super({
            host,
            cancellationToken,
            ...options,
            typingsInstaller,
            byteLength: () => { throw new Error('Not implemented'); }, // Formats the message text in send of Session which is overridden in this class so not needed
            hrtime,
            logger,
            canUseEvents: true,
        });
        this.port = port;
        this.wasmCancellationToken = cancellationToken;
        this.listener = (message) => {
            // TEMP fix since Cancellation.retrieveCheck is not correct
            function retrieveCheck2(data) {
                if (!globalThis.crossOriginIsolated || !(data.$cancellationData instanceof SharedArrayBuffer)) {
                    return () => false;
                }
                const typedArray = new Int32Array(data.$cancellationData, 0, 1);
                return () => {
                    return Atomics.load(typedArray, 0) === 1;
                };
            }
            const shouldCancel = retrieveCheck2(message.data);
            if (shouldCancel) {
                this.wasmCancellationToken.shouldCancel = shouldCancel;
            }
            try {
                if (message.data.command === 'updateOpen') {
                    const args = message.data.arguments;
                    for (const open of args.openFiles ?? []) {
                        if (open.projectRootPath) {
                            const uri = filePathToResourceUri(open.projectRootPath);
                            if (uri) {
                                projectRootPaths.set(open.projectRootPath, uri);
                            }
                        }
                    }
                }
            }
            catch {
                // Noop
            }
            this.onMessage(message.data);
        };
    }
    send(msg) {
        if (msg.type === 'event' && !this.canUseEvents) {
            if (this.logger.hasLevel(ts.server.LogLevel.verbose)) {
                this.logger.info(`Session does not support events: ignored event: ${JSON.stringify(msg)}`);
            }
            return;
        }
        if (this.logger.hasLevel(ts.server.LogLevel.verbose)) {
            this.logger.info(`${msg.type}:${indent(JSON.stringify(msg))}`);
        }
        this.port.postMessage(msg);
    }
    parseMessage(message) {
        return message;
    }
    toStringMessage(message) {
        return JSON.stringify(message, undefined, 2);
    }
    exit() {
        this.logger.info('Exiting...');
        this.port.removeEventListener('message', this.listener);
        this.projectService.closeLog();
        close();
    }
    listen() {
        this.logger.info(`webServer.ts: tsserver starting to listen for messages on 'message'...`);
        this.port.onmessage = this.listener;
    }
}
function parseServerMode(args) {
    const mode = findArgument(args, '--serverMode');
    if (!mode) {
        return undefined;
    }
    switch (mode.toLowerCase()) {
        case 'semantic':
            return ts.LanguageServiceMode.Semantic;
        case 'partialsemantic':
            return ts.LanguageServiceMode.PartialSemantic;
        case 'syntactic':
            return ts.LanguageServiceMode.Syntactic;
        default:
            return mode;
    }
}
function hrtime(previous) {
    const now = self.performance.now() * 1e-3;
    let seconds = Math.floor(now);
    let nanoseconds = Math.floor((now % 1) * 1e9);
    // NOTE: This check is added probably because it's missed without strictFunctionTypes on
    if (previous?.[0] !== undefined && previous?.[1] !== undefined) {
        seconds = seconds - previous[0];
        nanoseconds = nanoseconds - previous[1];
        if (nanoseconds < 0) {
            seconds--;
            nanoseconds += 1e9;
        }
    }
    return [seconds, nanoseconds];
}
function hasArgument(args, name) {
    return args.indexOf(name) >= 0;
}
function findArgument(args, name) {
    const index = args.indexOf(name);
    return 0 <= index && index < args.length - 1
        ? args[index + 1]
        : undefined;
}
function findArgumentStringArray(args, name) {
    const arg = findArgument(args, name);
    return arg === undefined ? [] : arg.split(',').filter(name => name !== '');
}
async function initializeSession(args, extensionUri, ports, logger) {
    const modeOrUnknown = parseServerMode(args);
    const serverMode = typeof modeOrUnknown === 'number' ? modeOrUnknown : undefined;
    const unknownServerMode = typeof modeOrUnknown === 'string' ? modeOrUnknown : undefined;
    logger.info(`Starting TS Server`);
    logger.info(`Version: 0.0.0`);
    logger.info(`Arguments: ${args.join(' ')}`);
    logger.info(`ServerMode: ${serverMode} unknownServerMode: ${unknownServerMode}`);
    const options = {
        globalPlugins: findArgumentStringArray(args, '--globalPlugins'),
        pluginProbeLocations: findArgumentStringArray(args, '--pluginProbeLocations'),
        allowLocalPluginLoads: hasArgument(args, '--allowLocalPluginLoads'),
        useSingleInferredProject: hasArgument(args, '--useSingleInferredProject'),
        useInferredProjectPerProjectRoot: hasArgument(args, '--useInferredProjectPerProjectRoot'),
        suppressDiagnosticEvents: hasArgument(args, '--suppressDiagnosticEvents'),
        noGetErrOnBackgroundUpdate: hasArgument(args, '--noGetErrOnBackgroundUpdate'),
        serverMode,
        disableAutomaticTypingAcquisition: hasArgument(args, '--disableAutomaticTypingAcquisition'),
    };
    let sys;
    let fs;
    if (hasArgument(args, '--enableProjectWideIntelliSenseOnWeb')) {
        const enabledExperimentalTypeAcquisition = hasArgument(args, '--experimentalTypeAcquisition');
        const connection = new browser_1.ClientConnection(ports.sync);
        await connection.serviceReady();
        const apiClient = new sync_api_client_1.ApiClient(connection);
        fs = apiClient.vscode.workspace.fileSystem;
        sys = createServerHost(extensionUri, logger, apiClient, args, ports.watcher, enabledExperimentalTypeAcquisition);
    }
    else {
        sys = createServerHost(extensionUri, logger, undefined, args, ports.watcher, false);
    }
    setSys(sys);
    session = new WorkerSession(sys, fs, options, ports.tsserver, logger, hrtime);
    session.listen();
}
function parseLogLevel(input) {
    switch (input) {
        case 'normal': return ts.server.LogLevel.normal;
        case 'terse': return ts.server.LogLevel.terse;
        case 'verbose': return ts.server.LogLevel.verbose;
        default: return undefined;
    }
}
let hasInitialized = false;
const listener = async (e) => {
    if (!hasInitialized) {
        hasInitialized = true;
        if ('args' in e.data) {
            const args = e.data.args;
            const logLevel = parseLogLevel(findArgument(args, '--logVerbosity'));
            const doLog = typeof logLevel === 'undefined'
                ? (_message) => { }
                : (message) => { postMessage({ type: 'log', body: message }); };
            const logger = {
                close: () => { },
                hasLevel: level => typeof logLevel === 'undefined' ? false : level <= logLevel,
                loggingEnabled: () => true,
                perftrc: () => { },
                info: doLog,
                msg: doLog,
                startGroup: () => { },
                endGroup: () => { },
                getLogFileName: () => undefined
            };
            const [sync, tsserver, watcher] = e.ports;
            const extensionUri = vscode_uri_1.URI.from(e.data.extensionUri);
            watcher.onmessage = (e) => updateWatch(e.data.event, vscode_uri_1.URI.from(e.data.uri), extensionUri);
            await initializeSession(args, extensionUri, { sync, tsserver, watcher }, logger);
        }
        else {
            console.error('unexpected message in place of initial message: ' + JSON.stringify(e.data));
        }
        return;
    }
    console.error(`unexpected message on main channel: ${JSON.stringify(e)}`);
};
addEventListener('message', listener);
function mapUri(uri, mappedScheme) {
    if (uri.scheme === 'vscode-global-typings') {
        throw new Error('can\'t map vscode-global-typings');
    }
    if (!uri.authority) {
        uri = uri.with({ authority: 'ts-nul-authority' });
    }
    uri = uri.with({ scheme: mappedScheme, path: `/${uri.scheme}/${uri.authority || 'ts-nul-authority'}${uri.path}` });
    return uri;
}
//# sourceMappingURL=webServer.js.map
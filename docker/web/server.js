'use strict';

// Runs Bob LearnHNS's main process (wallet, hsd node, services) under plain
// Node and serves its React UI as a web app. Browsers talk to the main process
// over a WebSocket that carries the same IPC messages Electron would.

const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const path = require('path');
const {WebSocketServer} = require('ws');
const {startNodeProxy} = require('./node-proxy');

const BOB_DIR = process.env.BOB_DIR || path.resolve(__dirname, '..', 'bob');
const DIST_DIR = path.join(BOB_DIR, 'dist');
const PORT = Number(process.env.PORT || 3000);
const DOWNLOADS_DIRNAME = 'web-downloads';

// ---- module stand-ins ------------------------------------------------------

const shim = require('./electron-shim');

// Error reporting to Sentry is switched off: it is built for the desktop app.
const noop = () => undefined;
const sentryStub = new Proxy({}, {
  get(_, prop) {
    if (prop === '__esModule' || prop === 'then') return undefined;
    if (prop === 'default') return sentryStub;
    return noop;
  },
});

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return shim;
  if (request.startsWith('@sentry/')) return sentryStub;
  if (request === 'electron-debug') return noop;
  return originalLoad.call(this, request, parent, isMain);
};

process.resourcesPath = BOB_DIR;

// ---- serialization ---------------------------------------------------------

// Electron IPC uses structured clone; JSON needs help with binary data.
function replacer(key, value) {
  const raw = this[key];
  if (raw instanceof Uint8Array) {
    return {__bobBytes: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64')};
  }
  return value;
}

function reviver(key, value) {
  if (value && typeof value === 'object' && typeof value.__bobBytes === 'string') {
    return Buffer.from(value.__bobBytes, 'base64');
  }
  return value;
}

const encode = msg => JSON.stringify(msg, replacer);
const decode = text => JSON.parse(text, reviver);

// ---- state -----------------------------------------------------------------

// Embedded in the page and required on the WebSocket, so other websites can't
// drive the wallet through the user's browser.
const sessionToken = crypto.randomBytes(32).toString('hex');
const clients = new Set();
let appReady = false;

// RPC calls made by the server itself (see autoStartNode) are answered here
// and never sent to browsers.
const SERVER_RPC_PREFIX = 'server:';
const serverRpcPending = new Map();
let serverRpcId = 0;

function serverRpc(method, params = []) {
  const id = `${SERVER_RPC_PREFIX}${++serverRpcId}`;
  return new Promise((resolve, reject) => {
    serverRpcPending.set(id, {resolve, reject});
    const event = {sender: mainWebContents(), senderFrame: null, returnValue: undefined};
    shim.ipcMain.emit('@@RPC@@', event, {jsonrpc: '2.0', method, params, id});
  });
}

function takeServerRpcResponse(channel, args) {
  if (channel !== '@@RPC@@' || typeof args[0] !== 'string' || !args[0].includes(SERVER_RPC_PREFIX)) return false;
  let data;
  try {
    data = JSON.parse(args[0]);
  } catch (e) {
    return false;
  }
  const pending = serverRpcPending.get(data.id);
  if (!pending) return false;
  serverRpcPending.delete(data.id);
  if (data.error) pending.reject(Object.assign(new Error(data.error.message), {code: data.error.code}));
  else pending.resolve(data.result);
  return true;
}

shim.transport.broadcast = (channel, args) => {
  if (takeServerRpcResponse(channel, args)) return;
  const msg = encode({t: 'event', channel, args});
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
};

function mainWebContents() {
  const windows = shim.BrowserWindow.getAllWindows();
  const win = windows[windows.length - 1];
  return win ? win.webContents : null;
}

function dispatchFromClient(ws, msg) {
  if (msg.t !== 'send' || typeof msg.channel !== 'string' || !Array.isArray(msg.args)) return;
  const event = {
    sender: mainWebContents(),
    senderFrame: null,
    returnValue: undefined,
    reply: (channel, ...args) => ws.send(encode({t: 'event', channel, args})),
  };
  shim.ipcMain.emit(msg.channel, event, ...msg.args);
}

// ---- HTTP ------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  'img-src * data: blob:',
  "connect-src 'self' ws: wss: https://shakex.fun https://liquidity.spot http://liquidity.spot https://*.sentry.io https://*.mixpanel.com",
  "frame-ancestors 'self'",
].join('; ');

function userDataDir() {
  return shim.app.getPath('userData');
}

function renderIndex() {
  const boot = {
    token: sessionToken,
    isPackaged: true,
    paths: {
      userData: userDataDir(),
      documents: shim.app.getPath('documents'),
      downloads: path.join(userDataDir(), DOWNLOADS_DIRNAME),
    },
    downloadsDir: path.join(userDataDir(), DOWNLOADS_DIRNAME),
  };
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bob DNS</title>
  <link rel="icon" type="image/png" href="./__bob/icon.png" />
  <style>html, body { margin: 0; padding: 0; font-family: system-ui, 'Roboto', sans-serif; font-size: 16px; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; overflow-x: hidden; }</style>
  <link rel="stylesheet" href="./style.css" />
</head>
<body>
<div id="root"></div>
<div id="modal-root"></div>
<script id="bob-boot" type="application/json">${bootJson}</script>
<script src="./__bob/bridge.js"></script>
<script src="./renderer.js" defer></script>
</body>
</html>
`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', ...headers});
  res.end(body);
}

function serveFile(res, filePath, extraHeaders = {}) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Files written by the main process into the downloads folder (for example
// the debug log) are handed to the browser once, then deleted.
function serveDownload(res, url) {
  if (url.searchParams.get('token') !== sessionToken) return send(res, 403, 'Forbidden');
  const root = path.join(userDataDir(), DOWNLOADS_DIRNAME) + path.sep;
  const requested = path.resolve(url.searchParams.get('path') || '');
  if (!requested.startsWith(root)) return send(res, 403, 'Forbidden');

  fs.stat(requested, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not ready');
    const name = path.basename(requested).replace(/["\\\r\n]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(requested);
    stream.pipe(res);
    stream.on('close', () => fs.rm(path.dirname(requested), {recursive: true, force: true}, noop));
  });
}

// ---- who may connect -------------------------------------------------------

// Every Umbrel app shares one Docker network, so any other app's container
// could reach this server directly and skip the Umbrel login. Only accept
// connections that come through Umbrel's own routing:
// - umbrelOS's app gateway runs on the host, so its connections arrive from
//   this network's gateway address (Tor remote access goes through it too);
// - older umbrelOS versions run an app_proxy container for this app instead
//   (BOB_WEB_PROXY_HOST, for example bob-wallet_app_proxy_1);
// - loopback, for anything inside this container.
// BOB_WEB_TRUSTED_IPS adds addresses; BOB_WEB_ALLOW_ANY_SOURCE=true turns the
// check off, for setups that route traffic some other way.
const ALLOW_ANY_SOURCE = process.env.BOB_WEB_ALLOW_ANY_SOURCE === 'true';
const PROXY_HOST = process.env.BOB_WEB_PROXY_HOST || '';
const staticTrusted = new Set(['127.0.0.1', '::1']);
for (const ip of (process.env.BOB_WEB_TRUSTED_IPS || '').split(',')) {
  if (ip.trim()) staticTrusted.add(ip.trim());
}

// The default route's gateway, from the kernel's routing table.
function defaultGateway() {
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination === '00000000' && gateway !== '00000000') {
        // Little-endian hex, e.g. 01001510 -> 16.21.0.1 reversed -> 10.21.0.1
        return gateway.match(/../g).reverse().map(byte => parseInt(byte, 16)).join('.');
      }
    }
  } catch (e) {
    // not Linux, or no routing table: rely on the other sources
  }
  return null;
}

const gatewayIp = defaultGateway();
if (gatewayIp) staticTrusted.add(gatewayIp);

let proxyIps = new Set();
let proxyResolvedAt = 0;
async function refreshProxyIps() {
  if (!PROXY_HOST) return;
  proxyResolvedAt = Date.now();
  try {
    const records = await dns.promises.lookup(PROXY_HOST, {all: true});
    proxyIps = new Set(records.map(record => record.address));
  } catch (e) {
    // Not resolvable: this umbrelOS has no app_proxy container
    proxyIps = new Set();
  }
}

const normalizeIp = ip => String(ip || '').replace(/^::ffff:/, '');
const rejectedLogged = new Set();

async function isTrustedSource(remoteAddress) {
  if (ALLOW_ANY_SOURCE) return true;
  const ip = normalizeIp(remoteAddress);
  if (staticTrusted.has(ip) || proxyIps.has(ip)) return true;
  // The proxy container may have been recreated with a new address.
  if (PROXY_HOST && Date.now() - proxyResolvedAt > 5000) {
    await refreshProxyIps();
    if (proxyIps.has(ip)) return true;
  }
  if (!rejectedLogged.has(ip)) {
    rejectedLogged.add(ip);
    console.warn(`[Bob web] Refused a connection from ${ip}: it did not come through Umbrel. ` +
      'Set BOB_WEB_TRUSTED_IPS or BOB_WEB_ALLOW_ANY_SOURCE=true if this is expected.');
  }
  return false;
}

console.log(ALLOW_ANY_SOURCE
  ? '[Bob web] Source check is off (BOB_WEB_ALLOW_ANY_SOURCE=true).'
  : `[Bob web] Accepting connections from: ${[...staticTrusted].join(', ')}${PROXY_HOST ? `, ${PROXY_HOST}` : ''}`);

const server = http.createServer(async (req, res) => {
  if (!(await isTrustedSource(req.socket.remoteAddress))) return send(res, 403, 'Forbidden');

  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 200, renderIndex(), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
  if (pathname === '/__bob/bridge.js') return serveFile(res, path.join(__dirname, 'bridge.js'), {'Cache-Control': 'no-cache'});
  if (pathname === '/__bob/icon.png') return serveFile(res, path.join(__dirname, 'icon.png'));
  if (pathname === '/__bob/download') return serveDownload(res, url);
  if (pathname === '/__bob/health') return send(res, 200, appReady ? 'ready' : 'starting');

  // Everything else comes from Bob's compiled renderer bundle.
  const filePath = path.resolve(DIST_DIR, '.' + pathname);
  if (!filePath.startsWith(DIST_DIR + path.sep)) return send(res, 403, 'Forbidden');
  return serveFile(res, filePath, {'Cache-Control': 'no-cache'});
});

// ---- WebSocket -------------------------------------------------------------

const wss = new WebSocketServer({noServer: true, maxPayload: 64 * 1024 * 1024});

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!(await isTrustedSource(req.socket.remoteAddress))
      || url.pathname !== '/__bob/ws' || url.searchParams.get('token') !== sessionToken) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

  // Messages that arrive before Bob's services finish starting wait here.
  const queue = [];
  const flush = () => {
    while (queue.length) dispatchFromClient(ws, queue.shift());
  };
  if (appReady) ws.send(encode({t: 'ready'}));
  else readyWaiters.push(() => { ws.send(encode({t: 'ready'})); flush(); });

  ws.on('message', data => {
    let msg;
    try {
      msg = decode(data.toString());
    } catch (e) {
      return;
    }
    if (!appReady) queue.push(msg);
    else dispatchFromClient(ws, msg);
  });
});

const readyWaiters = [];
function markReady() {
  if (appReady) return;
  appReady = true;
  console.log('[Bob web] Services started, UI is ready.');
  while (readyWaiters.length) readyWaiters.shift()();
  autoStartNode();
}

// Bob's NodeService.startNode() assumes it is never called twice at once: a
// second call made while the first is still opening hsd emits 'start local'
// without the wallet plugin, which crashes the wallet service. On the desktop
// only the one window calls it, but here the server (autoStartNode) and every
// browser tab can. Make overlapping calls wait for the one in progress.
function serializeNodeStarts() {
  const {service} = require(path.join(DIST_DIR, 'background', 'node', 'service.js'));
  const startNode = service.startNode.bind(service);
  let inFlight = null;
  service.startNode = function serializedStartNode() {
    const run = () => {
      inFlight = startNode().finally(() => { inFlight = null; });
      return inFlight;
    };
    return inFlight ? inFlight.catch(noop).then(run) : run();
  };
}

// hsd deadlock: when the wallet is far ahead of the chain (for example after
// switching from SPV to a fresh full node), WalletDB.syncNode() spends a while
// walking back to a common block while holding its txLock, then rescans
// through chain.scan(), which needs the chain lock. If the node is already
// connected, chain.add() holds the chain lock and waits on the wallet to
// connect the block: both wait forever and sync sits at 0%. Let the wallet
// finish catching up before the node connects to peers.
// Bob 2.3.19+ fixes this itself (wallet/localRescan.js defers the wallet sync
// until after connect and takes the locks in a safe order), so step aside
// when that is installed.
function waitForWalletBeforeConnect() {
  const hsdLib = path.join(BOB_DIR, 'node_modules', 'hsd', 'lib', 'node');
  for (const file of ['fullnode.js', 'spvnode.js']) {
    const NodeClass = require(path.join(hsdLib, file));
    const connect = NodeClass.prototype.connect;
    NodeClass.prototype.connect = async function connectAfterWalletSync(...args) {
      const plugin = this.get('walletdb');
      const wdb = plugin && plugin.wdb;
      if (wdb && wdb.txLock && typeof wdb.resumeLocalSync !== 'function') {
        const started = Date.now();
        const unlock = await wdb.txLock.lock();
        unlock();
        const waited = Math.round((Date.now() - started) / 1000);
        if (waited > 1) console.log(`[Bob web] Waited ${waited}s for the wallet to sync with the chain.`);
      }
      return connect.apply(this, args);
    };
  }
}

// In the desktop app the window is always open and starts the node right
// away. Here nobody may have the page open (for example after the Umbrel
// reboots), so start it the same way the UI does. Starting is idempotent:
// when a page connects later, Bob just refreshes its status.
let nodeProxyStarted = false;
async function autoStartNode() {
  try {
    const network = (await serverRpc('DB.get', ['network'])) || 'main';
    await serverRpc('Node.start', [network]);
    console.log(`[Bob web] Node started on ${network}.`);
    // The node's HTTP API is now up; expose the read-only slice of it to a
    // companion app (the Finestra explorer) over the Docker network.
    if (!nodeProxyStarted) {
      nodeProxyStarted = true;
      startNodeProxy(serverRpc);
    }
  } catch (e) {
    console.error('[Bob web] Could not start the node automatically:', e.message);
  }
}

// ---- start -----------------------------------------------------------------

// Bob calls showMainWindow() after every service has started; treat the
// window "loading" as the signal that RPC calls can be answered.
const OriginalBrowserWindow = shim.BrowserWindow;
const originalLoadURL = OriginalBrowserWindow.prototype.loadURL;
OriginalBrowserWindow.prototype.loadURL = function loadURL(url) {
  const result = originalLoadURL.call(this, url);
  this.webContents.once('did-finish-load', markReady);
  return result;
};

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Bob web] ${signal} received, shutting down.`);
  for (const ws of clients) ws.close(1001, 'Server shutting down');
  setTimeout(() => process.exit(0), 50000).unref();
  shim.app.quit();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`[Bob web] Listening on port ${PORT}`);
  require(path.join(DIST_DIR, 'main.js'));
  serializeNodeStarts();
  waitForWalletBeforeConnect();
  // Electron creates the userData folder before 'ready'; Bob relies on that.
  fs.mkdirSync(shim.app.getPath('userData'), {recursive: true});
  shim.app._ready = true;
  shim.app.emit('ready');
});

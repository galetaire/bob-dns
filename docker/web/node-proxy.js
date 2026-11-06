'use strict';

// Read-only Handshake node API proxy for a companion Umbrel app
// (the Finestra block explorer).
//
// Bob's wallet UI (port 3000) stays locked behind the Umbrel login, and hsd's
// node + wallet HTTP servers stay bound to 127.0.0.1 inside this container.
// This proxy opens ONE extra door onto the Docker network that is:
//   - read-only: only whitelisted, non-mutating node methods/paths pass through;
//   - node-only: it forwards to hsd's NODE http server, never the wallet server;
//   - source-restricted: only the containers named in NODE_PROXY_ALLOWED_HOSTS
//     (resolved by DNS) and loopback may connect;
//   - key-free for the caller: the proxy injects Bob's own nodeApiKey, so the
//     companion app never learns it.
//
// It is enabled by default but harmless when no companion app is installed: the
// allowed hostname simply does not resolve, so every outside connection is 403.

const http = require('http');
const dns = require('dns');

// Read-only JSON-RPC methods on hsd's node server. Deliberately excludes
// anything that broadcasts (sendrawtransaction), mines, mutates the mempool or
// peers (addnode/setban/generate), or touches the wallet.
const ALLOWED_RPC = new Set([
  // chain / node info
  'getinfo', 'getblockchaininfo', 'getnetworkinfo', 'getmininginfo',
  'getblockcount', 'getbestblockhash', 'getdifficulty', 'getconnectioncount',
  'getnetworkhashps',
  // blocks
  'getblock', 'getblockbyheight', 'getblockheader', 'getblockhash',
  'getchaintips',
  // transactions (read)
  'getrawtransaction', 'gettxout', 'gettxoutproof', 'verifytxoutproof',
  'decoderawtransaction', 'decodescript',
  // mempool (read)
  'getmempoolinfo', 'getrawmempool', 'getmempoolentry', 'estimatefee',
  'estimatesmartfee', 'estimatepriority',
  // names / auctions (the Handshake-specific data). getnames is left out on
  // purpose: it walks the whole name tree and would load the wallet's node.
  'getnameinfo', 'getnameresource', 'getnamebyhash',
  'getnameproof', 'getdnssecproof',
  // addresses
  'validateaddress',
]);

// Read-only REST GET paths on hsd's node server. Matched against the path that
// follows "/rest/". Address-indexed lookups work because Bob runs hsd with
// index-tx and index-address enabled.
const ALLOWED_REST = [
  /^$/,                              // GET /rest  -> node info (hsd "/")
  /^block\/[^/]+$/,                  // /block/:hashOrHeight
  /^header\/[^/]+$/,                 // /header/:hashOrHeight
  /^tx\/[0-9a-fA-F]{64}$/,           // /tx/:hash
  /^tx\/address\/[^/]+$/,            // /tx/address/:address
  /^coin\/[0-9a-fA-F]{64}\/\d+$/,    // /coin/:hash/:index
  /^coin\/address\/[^/]+$/,          // /coin/address/:address
  /^mempool$/,                       // /mempool
  /^fee$/,                           // /fee
];

// hsd has no limit on address lookups, and a very active address can return a
// huge response. Stop reading rather than buffer it all in the wallet's process.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const PORT = Number(process.env.NODE_PROXY_PORT || 3100);
const ENABLED = process.env.NODE_PROXY_ENABLED !== 'false';
const ALLOWED_HOSTS = (process.env.NODE_PROXY_ALLOWED_HOSTS || 'finestra-explorer_server_1')
  .split(',').map(h => h.trim()).filter(Boolean);

const normalizeIp = ip => String(ip || '').replace(/^::ffff:/, '');

// ---- who may connect -------------------------------------------------------

let allowedIps = new Set();
let resolvedAt = 0;

async function refreshAllowedIps() {
  resolvedAt = Date.now();
  const ips = new Set();
  for (const host of ALLOWED_HOSTS) {
    try {
      const records = await dns.promises.lookup(host, {all: true});
      for (const r of records) ips.add(r.address);
    } catch (e) {
      // Not resolvable yet: the companion app may not be installed/started.
    }
  }
  allowedIps = ips;
}

const rejectedLogged = new Set();
async function isAllowed(remoteAddress) {
  const ip = normalizeIp(remoteAddress);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (allowedIps.has(ip)) return true;
  // The companion container may have been (re)created with a new address.
  if (Date.now() - resolvedAt > 5000) {
    await refreshAllowedIps();
    if (allowedIps.has(ip)) return true;
  }
  if (!rejectedLogged.has(ip)) {
    rejectedLogged.add(ip);
    console.warn(`[Bob node-proxy] Refused ${ip}: not in NODE_PROXY_ALLOWED_HOSTS ` +
      `(${ALLOWED_HOSTS.join(', ') || 'none'}).`);
  }
  return false;
}

// ---- talking to hsd --------------------------------------------------------

function hsdRequest({rpcPort, apiKey, method, path, body}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: rpcPort,
      method,
      path,
      // hsd uses HTTP Basic auth with the api key as the password.
      auth: `x:${apiKey}`,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? {'Content-Length': payload.length} : {}),
      },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          reject(new Error('Response too large'));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('hsd request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- server ----------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// `getNode` returns {rpcPort, apiKey} for the running node, or throws.
function createProxyServer(getNode) {
  return http.createServer(async (req, res) => {
    try {
      if (!(await isAllowed(req.socket.remoteAddress))) return sendJson(res, 403, {error: 'Forbidden'});

      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && pathname === '/health') {
        let ok = false;
        try { getNode(); ok = true; } catch (e) {}
        return sendJson(res, 200, {status: ok ? 'ready' : 'starting'});
      }

      let ctx;
      try {
        ctx = getNode();
      } catch (e) {
        return sendJson(res, 503, {error: 'Node not ready'});
      }

      // JSON-RPC: POST /rpc {method, params}
      if (req.method === 'POST' && pathname === '/rpc') {
        let payload;
        try {
          payload = JSON.parse((await readBody(req)).toString() || '{}');
        } catch (e) {
          return sendJson(res, 400, {error: 'Invalid JSON body'});
        }
        const method = payload && payload.method;
        if (typeof method !== 'string' || !ALLOWED_RPC.has(method)) {
          return sendJson(res, 403, {error: `Method not allowed: ${method}`});
        }
        const params = Array.isArray(payload.params) ? payload.params : [];
        const result = await hsdRequest({
          rpcPort: ctx.rpcPort, apiKey: ctx.apiKey, method: 'POST', path: '/',
          body: {method, params, id: 1},
        });
        res.writeHead(result.status, {'Content-Type': 'application/json; charset=utf-8'});
        return res.end(result.body);
      }

      // REST passthrough: GET /rest/<whitelisted>
      if (req.method === 'GET' && pathname.startsWith('/rest')) {
        const rest = pathname.slice('/rest'.length).replace(/^\//, '');
        if (!ALLOWED_REST.some(re => re.test(rest))) {
          return sendJson(res, 403, {error: `Path not allowed: /${rest}`});
        }
        const result = await hsdRequest({
          rpcPort: ctx.rpcPort, apiKey: ctx.apiKey, method: 'GET',
          path: '/' + rest + (url.search || ''),
        });
        res.writeHead(result.status, {'Content-Type': 'application/json; charset=utf-8'});
        return res.end(result.body);
      }

      return sendJson(res, 404, {error: 'Not found'});
    } catch (e) {
      return sendJson(res, 502, {error: 'Proxy error', detail: String(e && e.message || e)});
    }
  });
}

// `getNode` comes from server.js and asks Bob's node service, so the port and
// key always match the node that is running. Bob's LearnHNS builds move hsd's
// ports by 1000, so the standard port numbers cannot be assumed here. Called on
// every request because the node can restart or change network.
function startNodeProxy(getNode) {
  if (!ENABLED) {
    console.log('[Bob node-proxy] Disabled (NODE_PROXY_ENABLED=false).');
    return;
  }

  refreshAllowedIps();
  const server = createProxyServer(getNode);
  server.on('error', e => console.error('[Bob node-proxy] Server error:', e.message));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Bob node-proxy] Read-only node API on 0.0.0.0:${PORT}. ` +
      `Allowed: ${ALLOWED_HOSTS.join(', ') || 'loopback only'}.`);
  });
  return server;
}

module.exports = {startNodeProxy, ALLOWED_RPC, ALLOWED_REST};

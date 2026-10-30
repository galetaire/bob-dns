// Browser implementation of the `window.bobElectron` bridge that Bob's
// Electron preload script normally provides. IPC goes over a WebSocket to the
// server; file dialogs and file access are handled in the browser.
(function () {
  'use strict';

  // Bob's renderer expects Node's `global`.
  window.global = window;

  const boot = JSON.parse(document.getElementById('bob-boot').textContent);
  const RPC = '@@RPC@@';
  const tabId = Math.random().toString(36).slice(2, 10);

  // ---- serialization (mirrors server.js) ----------------------------------

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function encode(msg) {
    return JSON.stringify(msg, function (key, value) {
      const raw = this[key];
      if (raw instanceof Uint8Array) return {__bobBytes: bytesToBase64(raw)};
      if (raw instanceof ArrayBuffer) return {__bobBytes: bytesToBase64(new Uint8Array(raw))};
      return value;
    });
  }

  function decode(text) {
    return JSON.parse(text, (key, value) => {
      if (value && typeof value === 'object' && typeof value.__bobBytes === 'string') {
        return base64ToBytes(value.__bobBytes);
      }
      return value;
    });
  }

  // ---- connection status overlay ------------------------------------------

  let overlay;
  function showOverlay(text) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('role', 'status');
      overlay.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
        'z-index:2147483647', 'padding:10px 18px', 'border-radius:8px',
        'background:rgba(20,20,30,.92)', 'color:#fff', 'font:14px system-ui,sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      ].join(';');
      document.body.appendChild(overlay);
    }
    overlay.textContent = text;
    overlay.style.display = 'block';
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  // ---- WebSocket transport ------------------------------------------------

  const listeners = new Map(); // id -> {channel, listener}
  let nextListenerId = 0;
  let socket = null;
  let ready = false;
  let everReady = false;
  let outbox = [];
  let retryDelay = 1000;
  let failures = 0;

  function deliver(channel, args) {
    for (const {channel: ch, listener} of [...listeners.values()]) {
      if (ch !== channel) continue;
      try {
        listener({sender: null}, ...args);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function handleEvent(channel, args) {
    if (channel === RPC) {
      // Responses go to every tab; keep only the ones this tab asked for.
      let data;
      try {
        data = JSON.parse(args[0]);
      } catch (e) {
        return;
      }
      const prefix = tabId + ':';
      if (typeof data.id !== 'string' || !data.id.startsWith(prefix)) return;
      data.id = Number(data.id.slice(prefix.length));
      deliver(RPC, [JSON.stringify(data)]);
      return;
    }
    deliver(channel, args);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = location.pathname.replace(/[^/]*$/, '');
    socket = new WebSocket(`${proto}//${location.host}${base}__bob/ws?token=${encodeURIComponent(boot.token)}`);

    socket.onmessage = ev => {
      let msg;
      try {
        msg = decode(ev.data);
      } catch (e) {
        return;
      }
      if (msg.t === 'ready') {
        ready = true;
        everReady = true;
        retryDelay = 1000;
        failures = 0;
        hideOverlay();
        const pending = outbox;
        outbox = [];
        pending.forEach(m => socket.send(m));
      } else if (msg.t === 'event') {
        handleEvent(msg.channel, msg.args || []);
      }
    };

    socket.onclose = () => {
      ready = false;
      if (everReady) {
        // In-flight calls are lost and the server may have restarted with a
        // new session token: wait for it, then reload to resync the whole UI.
        showOverlay('Connection to Bob lost. Reconnecting…');
        reloadWhenServerIsBack();
        return;
      }
      failures += 1;
      if (failures >= 3) {
        reloadWhenServerIsBack();
        return;
      }
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    };
  }

  function reloadWhenServerIsBack() {
    const base = location.pathname.replace(/[^/]*$/, '');
    const check = () => {
      fetch(`${base}__bob/health`, {cache: 'no-store'})
        .then(res => (res.ok ? location.reload() : setTimeout(check, 2000)))
        .catch(() => setTimeout(check, 2000));
    };
    setTimeout(check, 2000);
  }

  function sendToServer(channel, args) {
    const msg = encode({t: 'send', channel, args});
    if (ready && socket && socket.readyState === WebSocket.OPEN) socket.send(msg);
    else outbox.push(msg);
  }

  // ---- virtual files ------------------------------------------------------

  // Files the user picked in the browser, keyed by a made-up path.
  const pickedFiles = new Map();
  let pickCounter = 0;
  const PICK_ROOT = '/browser-upload/';
  const pendingSaves = new Map(); // save path -> poll timer

  function acceptFromFilters(filters) {
    const list = Array.isArray(filters) ? filters : (filters ? [filters] : []);
    const exts = [];
    list.forEach(f => (f.extensions || []).forEach(e => {
      if (e && e !== '*') exts.push('.' + String(e).replace(/^\./, ''));
    }));
    return exts.join(',');
  }

  function pickFile(options) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      const accept = acceptFromFilters(options && options.filters);
      if (accept) input.accept = accept;
      input.style.display = 'none';
      let done = false;
      const finish = result => {
        if (done) return;
        done = true;
        input.remove();
        resolve(result);
      };
      input.addEventListener('cancel', () => finish({canceled: true, filePaths: []}));
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return finish({canceled: true, filePaths: []});
        const bytes = new Uint8Array(await file.arrayBuffer());
        const vpath = `${PICK_ROOT}${++pickCounter}/${file.name}`;
        pickedFiles.set(vpath, bytes);
        finish({canceled: false, filePaths: [vpath]});
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function basename(p) {
    return String(p || '').split(/[\\/]/).pop();
  }

  function saveName(options) {
    const name = basename(options && options.defaultPath);
    if (name) return name;
    const list = options && Array.isArray(options.filters) ? options.filters : [];
    const ext = list[0] && list[0].extensions && list[0].extensions[0];
    return 'bob-export' + (ext && ext !== '*' ? '.' + ext : '');
  }

  function triggerDownload(href, name) {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadBytes(name, data) {
    const blob = new Blob([data], {type: 'application/octet-stream'});
    const url = URL.createObjectURL(blob);
    triggerDownload(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Some saves are written by the server instead (for example the debug
  // log). Poll until the file shows up, then download it.
  function watchServerSave(savePath) {
    const started = Date.now();
    const base = location.pathname.replace(/[^/]*$/, '');
    const url = `${base}__bob/download?token=${encodeURIComponent(boot.token)}&path=${encodeURIComponent(savePath)}`;
    const poll = async () => {
      if (!pendingSaves.has(savePath)) return;
      try {
        const res = await fetch(url, {method: 'HEAD', cache: 'no-store'});
        if (res.ok) {
          pendingSaves.delete(savePath);
          triggerDownload(url, basename(savePath));
          return;
        }
      } catch (e) {
        // try again
      }
      if (Date.now() - started > 120000) {
        pendingSaves.delete(savePath);
        return;
      }
      pendingSaves.set(savePath, setTimeout(poll, 1000));
    };
    pendingSaves.set(savePath, setTimeout(poll, 500));
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) return new Uint8Array(data.data);
    return new TextEncoder().encode(String(data));
  }

  function readPicked(filePath, encoding) {
    const bytes = pickedFiles.get(filePath);
    if (!bytes) throw new Error('File access was not authorized by a Bob file dialog.');
    if (encoding) return new TextDecoder(encoding === 'utf-8' || encoding === 'utf8' ? 'utf-8' : encoding).decode(bytes);
    return bytes;
  }

  function askServerDirectory(title) {
    const suggestion = boot.paths.userData + '/backups';
    const answer = window.prompt(
      (title ? title + '\n\n' : '') +
      'Enter a folder on your Umbrel. Bob runs on the server, so it can only use server folders. ' +
      'Folders under the path below are kept in the app\'s data folder on your Umbrel.',
      suggestion,
    );
    return answer && answer.trim() ? [answer.trim()] : undefined;
  }

  // ---- the bridge ---------------------------------------------------------

  window.bobElectron = {
    ipc: {
      send(channel, ...args) {
        if (channel === 'BOB/TRACE_DEEPLINK') return;
        if (channel === RPC && args[0] && typeof args[0] === 'object') {
          args = [Object.assign({}, args[0], {id: `${tabId}:${args[0].id}`})].concat(args.slice(1));
        }
        sendToServer(channel, args);
      },
      on(channel, listener) {
        const id = ++nextListenerId;
        listeners.set(id, {channel, listener});
        return id;
      },
      off(id) {
        listeners.delete(id);
      },
    },
    shell: {
      openExternal(url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return Promise.resolve(false);
          window.open(parsed.href, '_blank', 'noopener,noreferrer');
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      },
    },
    dialog: {
      showOpenDialog(options) {
        const props = (options && options.properties) || [];
        if (props.includes('openDirectory')) {
          const dirs = askServerDirectory(options && options.title);
          return Promise.resolve({canceled: !dirs, filePaths: dirs || []});
        }
        return pickFile(options);
      },
      showOpenDialogSync(options) {
        const props = (options && options.properties) || [];
        if (props.includes('openDirectory')) return askServerDirectory(options && options.title);
        // A synchronous file picker is impossible in a browser.
        window.alert('This action is not available in the web version of Bob.');
        return undefined;
      },
      showSaveDialogSync(options) {
        const dir = `${boot.downloadsDir}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const savePath = `${dir}/${saveName(options)}`;
        watchServerSave(savePath);
        return savePath;
      },
    },
    files: {
      readFile(filePath, encoding) {
        try {
          return Promise.resolve(readPicked(filePath, encoding));
        } catch (e) {
          return Promise.reject(e);
        }
      },
      readFileSync(filePath, encoding) {
        return readPicked(filePath, encoding);
      },
      writeFile(filePath, data) {
        // The UI wrote the file itself: download it straight from the browser.
        const timer = pendingSaves.get(filePath);
        if (timer) clearTimeout(timer);
        pendingSaves.delete(filePath);
        downloadBytes(basename(filePath), toBytes(data));
        return Promise.resolve(true);
      },
    },
    app: {
      isPackaged: boot.isPackaged,
      // Bob's packaged-test mode; never on for real users
      isAcceptance: false,
      getPath(name) {
        return boot.paths[name] || null;
      },
    },
  };

  showOverlay('Starting Bob…');
  connect();
})();

# Bob Wallet Umbrel Community App Store

An [umbrelOS community app store](https://github.com/getumbrel/umbrel-community-app-store):

- **Bob DNS** (`bob-wallet`): the [Bob LearnHNS](https://github.com/shadstoneofficial/bob-wallet) Handshake wallet and full node, running on your Umbrel as a web app.

## Credits

This is an unofficial Umbrel package of **Bob LearnHNS**, maintained separately from the original project. All credit for the wallet goes to its authors:

- [Bob LearnHNS](https://github.com/shadstoneofficial/bob-wallet) by Shadstone / LearnHNS: the wallet this app runs, built from its release tags.
- [Bob Wallet](https://github.com/kyokan/bob-wallet) by Kyokan Group: the original Bob that Bob LearnHNS is based on.
- [hsd](https://github.com/handshake-org/hsd) by the Handshake developers: the Handshake node inside Bob.

This repository only adds the Umbrel packaging: the web server that runs Bob without its desktop shell, the Docker build, and the app store files. Problems with the wallet itself belong upstream; problems with running it on Umbrel belong here.

Bob LearnHNS is licensed under the [GNU General Public License v3](https://github.com/shadstoneofficial/bob-wallet/blob/master/LICENSE). The Docker image includes that license at `/opt/bob/LICENSE`, and `/opt/bob/NOTICE` points to the source code of both Bob and this packaging.

## How it works

Bob is an Electron desktop app, but it is split cleanly in two:

- a **main process** (wallet, hsd node, background services) that is plain Node code, and
- a **React UI** that is already built as a web bundle and talks to the main process only through one bridge object, `window.bobElectron`, through Bob's JSON-RPC style IPC.

This image runs both without Electron:

| File | Role |
| --- | --- |
| `docker/web/server.js` | Runs Bob's compiled `main.js` under Node, serves the UI bundle over HTTP, and carries IPC messages over a WebSocket. |
| `docker/web/electron-shim.js` | A stand-in for the `electron` module (`app`, `ipcMain`, `BrowserWindow`, …). The "main window" is every connected browser. |
| `docker/web/bridge.js` | The browser's `window.bobElectron`. Saving a file downloads it, opening a file uses the browser's file picker, and links open in a new tab. |

Bob is built from its release tag for both **amd64** and **arm64** (Raspberry Pi), on GitHub's native runners. Umbrel's `app_proxy` puts the app behind your Umbrel login on port **8337**. The WebSocket also requires a per-start session token embedded in the page, so other websites can't drive the wallet through your browser. The server also only accepts connections routed by Umbrel (umbrelOS's app gateway, or this app's `app_proxy` container on older versions), so other apps on the same Umbrel can't reach the wallet directly and skip the Umbrel login.

Not supported in the web version: Ledger hardware wallets (no USB access) and `bob://` deep links. Folder pickers (wallet DB backup, moving the node's data folder) ask for a folder path on the Umbrel instead.

## Repository layout

```
umbrel-app-store.yml               store id + name
bob-wallet/                        the Umbrel app (manifest + compose)
docker/Dockerfile                  builds Bob from source and the web server
docker/web/                        web server, Electron stand-in, browser bridge
.github/workflows/build-image.yml  builds and pushes ghcr.io/<owner>/bob-learnhns
```

## Installing

In umbrelOS go to **App Store** → **Community App Stores** →  **Manage**, paste `https://github.com/galetaire/bob-umbrel` and install **Bob DNS**.

## Data and backups

All of Bob's data, including wallets and the Handshake chain, is stored in `~/umbrel/app-data/bob-wallet/data/config` on the Umbrel (`/data` in the container). Uninstalling the app deletes it, so **write down your seed phrase** before you uninstall or test anything.

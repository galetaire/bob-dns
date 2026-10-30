# Bob LearnHNS as a web app.
# Bob's wallet, hsd node and services run under plain Node (no Electron),
# and its React UI is served to the browser. See web/server.js.

ARG BOB_VERSION=2.3.19

# ---- build Bob from the release tag ----
FROM node:22-bookworm AS build
ARG BOB_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libudev-dev \
    libunbound-dev \
    libusb-1.0-0-dev \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "v${BOB_VERSION}" \
    https://github.com/shadstoneofficial/bob-wallet.git .

# Bob's own postinstall rebuilds native modules for Electron. Skip it and
# build them for Node instead, since the server runs on Node.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm rebuild \
  && node scripts/force-goosig-mini-gmp.js

# The renderer's Sentry SDK needs Electron's main process to talk to.
# Switch it off in the web build (the server side is stubbed in server.js).
COPY web/sentry-renderer-stub.js app/renderer/sentry-stub.js
RUN echo "// Sentry is disabled in the web build" > app/renderer/sentry.js \
  && sed -i "s#^    alias: {#    alias: {\n      '@sentry/electron/renderer\$': path.join(__dirname, '..', 'app', 'renderer', 'sentry-stub.js'),#" \
    configs/webpack.config.renderer.prod.babel.js \
  && grep -q "sentry-stub.js" configs/webpack.config.renderer.prod.babel.js

# Bob's build records its source commit and refuses a modified worktree.
# Commit the web-build changes locally so the recorded commit is honest.
RUN git add -A app configs \
  && git -c user.name="bob-umbrel build" -c user.email="build@bob-umbrel.invalid" \
    commit -q -m "Umbrel web build: disable the renderer's Sentry SDK" \
  && test -z "$(git status --porcelain --untracked-files=normal)"

# Compiles the renderer bundle and the main-process code into dist/
RUN npm run build && npm prune --omit=dev

WORKDIR /web
COPY web/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY web/ ./
RUN cp /src/resources/icons/512x512.png ./icon.png

# ---- runtime ----
FROM node:22-bookworm-slim
ARG BOB_VERSION

LABEL org.opencontainers.image.title="Bob LearnHNS" \
      org.opencontainers.image.description="Bob LearnHNS Handshake wallet as a web app for umbrelOS" \
      org.opencontainers.image.version="${BOB_VERSION}" \
      org.opencontainers.image.source="https://github.com/galetaire/bob-umbrel"

RUN apt-get update && apt-get install -y --no-install-recommends \
    libudev1 \
    libunbound8 \
    libusb-1.0-0 \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/package.json /opt/bob/package.json
# Bob is GPL-3.0: ship its license and say where the source of both parts lives
COPY --from=build /src/LICENSE /opt/bob/LICENSE
RUN printf '%s\n' \
    "This image contains Bob LearnHNS v${BOB_VERSION}, licensed under the GNU General" \
    "Public License v3. See /opt/bob/LICENSE." \
    "" \
    "Bob LearnHNS source code:" \
    "  https://github.com/shadstoneofficial/bob-wallet/tree/v${BOB_VERSION}" \
    "" \
    "Umbrel packaging (web server in /opt/bob-web, Dockerfile, and the changes" \
    "applied to Bob at build time):" \
    "  https://github.com/galetaire/bob-umbrel" \
    > /opt/bob/NOTICE
COPY --from=build /src/dist /opt/bob/dist
COPY --from=build /src/node_modules /opt/bob/node_modules
COPY --from=build /web /opt/bob-web

# Bob keeps everything under $HOME/.config/Bob LearnHNS. /data matches the
# folder the earlier KasmVNC version of this app used, so data carries over.
ENV NODE_ENV=production \
    BOB_DIR=/opt/bob \
    BOB_VERSION=${BOB_VERSION} \
    HOME=/data \
    PORT=3000

RUN mkdir -p /data && chown node:node /data \
  && chmod 755 /opt/bob-web/entrypoint.sh

# The entrypoint starts as root to fix /data ownership, then runs Bob as
# uid/gid 1000 (the node image's "node" user, like Umbrel's app data).
EXPOSE 3000
VOLUME /data

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/bob-web/entrypoint.sh"]
CMD ["node", "/opt/bob-web/server.js"]

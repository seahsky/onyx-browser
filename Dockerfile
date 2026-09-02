# ---- UI build -------------------------------------------------------------
FROM node:22-bookworm-slim AS ui-build
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ---- Backend build ----------------------------------------------------------
FROM node:22-bookworm-slim AS backend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# ---- Production node_modules ------------------------------------------------
# better-sqlite3 needs a native build; most platforms get a prebuilt binary,
# but the build toolchain is here as a fallback so this never depends on one
# being available. Removed again in the same layer so it doesn't bloat this
# stage — its output (node_modules) is the only thing the runtime stage copies.
FROM node:22-bookworm-slim AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ---- Runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Debian's chromium package, not playwright-core's own bundled download —
# the image supplies Chromium (see the build spec's stack table).
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 onyx \
    && useradd --system --uid 1001 --gid onyx --home-dir /app --shell /usr/sbin/nologin onyx \
    && mkdir -p /data && chown onyx:onyx /data

WORKDIR /app
COPY --chown=onyx:onyx --from=runtime-deps /app/node_modules ./node_modules
COPY --chown=onyx:onyx package.json ./
COPY --chown=onyx:onyx --from=backend-build /app/dist ./dist
COPY --chown=onyx:onyx drizzle ./drizzle
COPY --chown=onyx:onyx --from=ui-build /app/ui/dist ./ui/dist

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV ONYX_DATABASE_URL=file:/data/onyx.db
ENV ONYX_CHROME_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000
VOLUME ["/data"]

# Chrome's own sandbox needs user namespaces; most container runtimes don't
# grant an unprivileged container those by default. src/browser/manager.ts
# already detects that failure at launch and retries with --no-sandbox, so
# nothing here forces one path or the other. Prefer running this image with
# user namespaces enabled and a seccomp profile that allows unshare(2) if
# you want Chrome's real sandbox instead of that fallback.
USER onyx

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]

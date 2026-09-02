# Onyx

A self-hostable browser-as-a-service: a REST API for session lifecycle,
Chrome DevTools Protocol (CDP) over WebSocket for Playwright/Puppeteer/
Selenium, and a web UI for creating and watching sessions.

[Steel Browser](https://github.com/steel-dev/steel-browser) is the reference
for scope. The difference is authentication: Steel's self-hosted container
ships with none, and auth for it has been an open feature request since
December 2025 ([steel-dev/steel-browser#235](https://github.com/steel-dev/steel-browser/issues/235)).
Onyx builds auth in from the start — it's milestone one, before a browser is
ever launched.

## Status

Auth, browser lifecycle, the CDP proxy, egress control, the web UI, and
packaging all work end to end against the milestone plan in `CLAUDE.md`.

## Requirements

Chromium needs roughly **4 GB RAM** and **10 GB disk** to run reliably.
Undersizing this doesn't fail loudly — the container looks healthy until the
first session request. Size accordingly before deploying.

## Development

```
npm install
cp .env.example .env   # fill in ONYX_SESSION_SECRET at minimum
npm run build:ui        # one-time: installs and builds ui/
npm run dev
```

The UI lives in `ui/` as its own Vite project. For UI development with hot
reload, run `npm run dev` here for the API and `npm run dev` in `ui/` for
the frontend (its dev server proxies `/v1`, `/health`, and `/setup` to
`localhost:3000`). For a single-process check, `npm run build` builds both
and `npm start` serves the built UI from the same port as the API.

```
npm run build && npm test && curl -sf localhost:3000/health
```

## Running with Docker

```
docker build -t onyx .
docker run -p 3000:3000 \
  -e ONYX_SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')" \
  -e ONYX_ADMIN_EMAIL=admin@example.com \
  -e ONYX_ADMIN_PASSWORD='a-long-enough-password' \
  -e ONYX_PUBLIC_URL=http://localhost:3000 \
  -v onyx-data:/data \
  onyx
```

The image builds the UI and backend in separate stages, installs Chromium
from Debian's own package (not a `playwright install` download), and runs as
a non-root user. `/data` holds the SQLite database — mount it as a volume or
it resets on every container recreate. `ONYX_CHROME_EXECUTABLE_PATH` and
`ONYX_DATABASE_URL` are already set correctly by the image; only the four
env vars above need to be supplied.

**Note on this repository's own testing:** the Dockerfile and
`zeabur-template.yaml` were written carefully against known Docker/Zeabur
mechanics, but the sandbox this was built in couldn't reach Docker Hub's
blob CDN to actually run `docker build` — every other milestone's check
(including the rest of M7's own requirements) was verified by actually
running it; this one wasn't. Build and run it yourself before trusting it in
production, and open an issue if something's off.

## Deploying to Zeabur

`zeabur-template.yaml` deploys straight from this repository via
`npx zeabur@latest template deploy -f zeabur-template.yaml`, or by
submitting it through Zeabur's template marketplace flow. `ONYX_SESSION_SECRET`
and `ONYX_ADMIN_PASSWORD` are generated for you; set `ONYX_ADMIN_EMAIL`
before the first deploy to bootstrap that account directly, or check the
service's logs after boot for a one-time setup token.

See `CLAUDE.md` for the full milestone plan, working agreement, and layout.

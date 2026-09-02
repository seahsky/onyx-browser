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

Under active development against the milestone plan in `CLAUDE.md`. Not yet
ready to run a browser session end to end.

## Requirements

Chromium needs roughly **4 GB RAM** and **10 GB disk** to run reliably.
Undersizing this doesn't fail loudly — the container looks healthy until the
first session request. Size accordingly before deploying.

## Development

```
npm install
cp .env.example .env   # fill in ONYX_SESSION_SECRET at minimum
npm run dev
```

```
npm run build && npm test && curl -sf localhost:3000/health
```

See `CLAUDE.md` for the full milestone plan, working agreement, and layout.

# Onyx

Self-hostable browser-as-a-service: REST API for session lifecycle, CDP over
WebSocket for Playwright/Puppeteer/Selenium, and a web UI for creating and
watching sessions. The full spec lives in the project's build-spec document
(milestones M0–M7); this file is the day-to-day working agreement for anyone
— human or agent — writing code here.

## Non-negotiables

- **Auth is milestone one.** Steel Browser's self-hosted image ships with no
  authentication. That gap is why this project exists — never add a route,
  even temporarily, that bypasses the principal hook "to get something
  working."
- **Single process, single port.** Do not split the API and UI into separate
  services.
- **No multi-tenancy, no stealth/fingerprint spoofing, no horizontal
  scaling.** If a change seems to need one of these, stop and ask instead of
  building it.

## Working agreement

- Conventional commits. One commit per logical change, not per file.
- No `any`. No `@ts-expect-error` without a comment naming the upstream issue.
- Every route gets a Zod schema for params, query, body, and response.
- A new route without an entry in the M2 auth table (`test/*401*`) is a build
  failure, by design — that test enumerates every registered route.
- Secrets never reach logs. Redact `Authorization`, `Cookie`, `apiKey`, and
  `password` at the logger's serializer (`src/logger.ts`), not at each call
  site.
- Comment why, not what.
- If a decision in the build spec turns out to be wrong, stop and say so. Do
  not silently substitute a different approach.

## Milestones

Each milestone ends with a command that must pass before the next one starts.
Commit at each boundary.

| # | Scope | Check |
|---|---|---|
| M0 | Skeleton: TS strict, Fastify boot, config schema, SQLite migrations, `/health`, Vitest | `npm run build && npm test && curl -sf localhost:3000/health` |
| M1 | Auth, no browser: users, sessions, API keys, principal hook, rate limiting, bootstrap, audit log | Integration tests: login success/failure, cookie issue/revoke, key create/authenticate/revoke, revoked key rejected |
| M2 | The 401 test: every registered route outside an explicit allowlist requires credentials | Passes, and fails correctly when a route is temporarily unguarded |
| M3 | Browser lifecycle: launch Chromium, session CRUD, idle/absolute timeouts, concurrency cap, signal cleanup | Create a session, assert Chrome running, release, assert process gone, no orphans after the suite exits |
| M4 | CDP proxy: authenticated WebSocket proxy, all three credential paths, query-param redaction | `playwright-core`'s `connectOverCDP` works through the proxy with a bearer header; no credentials is rejected at upgrade |
| M5 | Egress control: scheme denies, resolved-address checks, DNS rebinding protection | `file:///etc/passwd`, `http://127.0.0.1:3000`, `http://169.254.169.254/` are all blocked and audit-logged |
| M6 | UI: login, key management, session list, create session, live viewer | Playwright test: log in, create a key, create a session, viewer renders a frame |
| M7 | Packaging: Dockerfile, non-root user, healthcheck, Zeabur template | `docker run` with only `ONYX_SESSION_SECRET`, `ONYX_ADMIN_EMAIL`, `ONYX_ADMIN_PASSWORD`, `ONYX_PUBLIC_URL` works from a fresh clone |

## Commands

```
npm run dev         # tsx watch, runs src/index.ts directly
npm run build        # tsc -p tsconfig.build.json -> dist/
npm start            # node dist/index.js
npm test             # vitest run
npm run typecheck    # tsc --noEmit (src + test)
npm run db:generate   # drizzle-kit generate, after editing src/db/schema.ts
```

## Layout

```
src/
  config.ts        Zod-validated env config, loadConfig()
  url.ts            createPublicUrl() — the only place that builds a public URL
  logger.ts         pino instance with secret redaction
  server.ts         buildApp() — Fastify instance, plugins, routes
  index.ts          entry point: load config, boot db, listen, signal handling
  db/
    schema.ts       Drizzle table definitions
    index.ts        connection + migration runner
  auth/             password hashing, sessions, API keys, principal resolution, bootstrap, audit log
  browser/          BrowserSessionManager — one Chrome process per session, timeouts, concurrency cap
  plugins/          fastify-plugin modules (cookie + principal onRequest hook + auth guards)
  routes/           one file per route group, each with full Zod schemas
test/
  helpers/app.ts    buildTestApp() — wires a full app against a throwaway db
```

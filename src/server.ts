import Fastify, { type FastifyBaseLogger } from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { BrowserSessionManager } from "./browser/manager.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { createPublicUrl } from "./url.js";
import authPlugin from "./plugins/auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerKeyRoutes } from "./routes/keys.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerCdpRoute } from "./routes/cdp.js";
import { registerViewerRoute } from "./routes/viewer.js";

export interface RouteInventoryEntry {
  method: string;
  url: string;
}

export interface BuildAppOptions {
  config: Config;
  // Typed against Fastify's own logger interface, not pino's concrete Logger
  // type — passing the pino instance here still works (it satisfies this
  // shape), but pinning the param to pino.Logger makes TS infer Fastify's
  // internal Logger generic as pino.Logger everywhere, which then fails to
  // unify with the FastifyBaseLogger default used by every route module.
  logger: FastifyBaseLogger;
  db: Db;
}

export async function buildApp({ config, logger, db }: BuildAppOptions) {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: false,
    // Fastify's default (forceCloseConnections: 'idle') only calls
    // server.closeIdleConnections() when a custom serverFactory is set —
    // with the plain default HTTP server it's a no-op, so close() would
    // wait indefinitely for any connection that doesn't close itself
    // (exactly what an upgraded CDP proxy socket can do, mid-request).
    // true unconditionally destroys every open connection on close().
    forceCloseConnections: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("publicUrl", createPublicUrl(config));

  const browserSessionManager = new BrowserSessionManager(db, config, logger);
  app.decorate("browserSessions", browserSessionManager);
  // Covers both graceful shutdown (index.ts calls app.close() on SIGTERM/
  // SIGINT) and every test's app.close() in its cleanup — no orphaned
  // Chrome processes need a separate teardown path.
  app.addHook("onClose", async () => {
    await browserSessionManager.closeAll();
  });

  // Registered before any plugin so it captures every route, including ones
  // added by third-party plugins (swagger-ui's static/json routes, Fastify's
  // auto-added HEAD for GET). Backs the M2 401 test's route enumeration.
  const routeInventory: RouteInventoryEntry[] = [];
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      routeInventory.push({ method, url: routeOptions.url });
    }
  });
  app.decorate("routeInventory", routeInventory);

  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, {
    // @fastify/websocket's default preClose does a graceful client.close()
    // per connection, which waits for a clean closing handshake. That races
    // badly with a client that already disconnected a moment earlier (e.g.
    // the CDP proxy, once its counterpart has gone away) — shutdown can
    // hang waiting on a handshake the other side will never complete.
    // terminate() drops the socket immediately; shutdown must never hang on
    // connection state it doesn't control.
    preClose(done) {
      for (const client of app.websocketServer.clients) {
        client.terminate();
      }
      app.websocketServer.close(() => done());
    },
  });
  await app.register(authPlugin);

  await app.register(swagger, {
    openapi: {
      info: { title: "Onyx", version: "0.1.0" },
      servers: [{ url: config.publicOrigin }],
    },
    transform: jsonSchemaTransform,
  });

  // /documentation requires a user session — registered in its own child
  // context so the guard hook only covers the swagger-ui routes, not the
  // whole app.
  await app.register(async (scoped) => {
    scoped.addHook("onRequest", app.requireUserSession);
    await scoped.register(swaggerUi, { routePrefix: "/documentation" });
  });

  await registerHealthRoute(app);
  await registerAuthRoutes(app);
  await registerKeyRoutes(app);
  await registerSessionRoutes(app);
  await registerCdpRoute(app);
  await registerViewerRoute(app);

  return app;
}

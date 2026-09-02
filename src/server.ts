import Fastify, { type FastifyBaseLogger } from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { createPublicUrl } from "./url.js";
import authPlugin from "./plugins/auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerKeyRoutes } from "./routes/keys.js";

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
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("publicUrl", createPublicUrl(config));

  await app.register(sensible);
  await app.register(rateLimit, { global: false });
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

  return app;
}

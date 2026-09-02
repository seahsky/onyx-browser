import Fastify, { type FastifyBaseLogger } from "fastify";
import sensible from "@fastify/sensible";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { createPublicUrl } from "./url.js";
import { registerHealthRoute } from "./routes/health.js";

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

  await registerHealthRoute(app);

  return app;
}

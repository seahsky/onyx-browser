import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./logger.js";
import { createDb, runMigrations } from "./db/index.js";
import { buildApp } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const logger = createLogger(config.isProduction);

  if (config.allowPrivateNetwork) {
    logger.warn("ONYX_ALLOW_PRIVATE_NETWORK=true — private-network egress denies are disabled");
  }

  const db = createDb(config.databaseUrl);
  runMigrations(db);

  const app = await buildApp({ config, logger, db });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

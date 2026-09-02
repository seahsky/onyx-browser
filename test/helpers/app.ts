import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createDb, runMigrations, type Db } from "../../src/db/index.js";
import { buildApp } from "../../src/server.js";

export interface TestApp {
  app: FastifyInstance;
  config: Config;
  db: Db;
  cleanup: () => Promise<void>;
}

/** Builds a fully wired app against a throwaway SQLite file for one test. */
export async function buildTestApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const dbFile = path.join(os.tmpdir(), `onyx-test-${randomUUID()}.db`);

  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    ONYX_SESSION_SECRET: "a".repeat(32),
    ONYX_DATABASE_URL: `file:${dbFile}`,
    ...envOverrides,
  });

  const logger = createLogger(false);
  logger.level = "silent";

  const db = createDb(config.databaseUrl);
  runMigrations(db);

  const app = await buildApp({ config, logger, db });

  const cleanup = async (): Promise<void> => {
    await app.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbFile}${suffix}`, { force: true });
    }
  };

  return { app, config, db, cleanup };
}

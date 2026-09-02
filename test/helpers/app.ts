import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createDb, runMigrations, type Db } from "../../src/db/index.js";
import { hashPassword } from "../../src/auth/password.js";
import { users } from "../../src/db/schema.js";
import { buildApp } from "../../src/server.js";

export interface TestApp {
  app: FastifyInstance;
  config: Config;
  db: Db;
  cleanup: () => Promise<void>;
}

/**
 * Builds a fully wired app against a throwaway SQLite file for one test.
 * Does not run bootstrap — most tests seed a known user via createTestUser
 * instead; tests that specifically exercise bootstrap call it themselves.
 */
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

export interface TestUserOptions {
  email?: string;
  password?: string;
  role?: "admin" | "user";
}

export interface TestUser {
  id: string;
  email: string;
  role: "admin" | "user";
  password: string;
}

/** Inserts a user directly, bypassing bootstrap, for tests that need a known login. */
export async function createTestUser(db: Db, opts: TestUserOptions = {}): Promise<TestUser> {
  const email = opts.email ?? `user-${randomUUID()}@example.com`;
  const password = opts.password ?? "correct horse battery staple";
  const passwordHash = await hashPassword(password);

  const [row] = db
    .insert(users)
    .values({ email, passwordHash, role: opts.role ?? "user" })
    .returning({ id: users.id, email: users.email, role: users.role })
    .all();

  return { ...row!, password };
}

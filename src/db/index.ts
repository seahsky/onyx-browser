import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

function resolveDatabasePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(`ONYX_DATABASE_URL must start with "file:", got "${databaseUrl}"`);
  }
  return databaseUrl.slice("file:".length);
}

export function createDb(databaseUrl: string): Db {
  const dbPath = resolveDatabasePath(databaseUrl);
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

// dist/db/index.js and src/db/index.ts sit at the same depth relative to the
// repo root, so this resolves correctly whether running built or via tsx.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}

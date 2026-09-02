import { randomUUID } from "node:crypto";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
});

export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    absoluteExpiresAt: integer("absolute_expires_at", { mode: "timestamp_ms" }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("user_sessions_user_id_idx").on(table.userId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey().$defaultFn(() => randomUUID()),
    keyId: text("key_id").notNull().unique(),
    secretHash: text("secret_hash").notNull(),
    label: text("label").notNull(),
    scopes: text("scopes", { mode: "json" }).notNull().$type<string[]>(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("api_keys_owner_id_idx").on(table.ownerId)],
);

// createdBy is a principal ref: { kind: "user" | "apiKey", id } split into two
// columns so sessions can be queried/joined by owner without decoding JSON.
export const browserSessions = sqliteTable("browser_sessions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  status: text("status", { enum: ["starting", "running", "releasing", "released", "crashed"] }).notNull(),
  createdByKind: text("created_by_kind", { enum: ["user", "apiKey"] }).notNull(),
  createdById: text("created_by_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  releasedAt: integer("released_at", { mode: "timestamp_ms" }),
  idleTimeoutMs: integer("idle_timeout_ms").notNull(),
  maxLifetimeMs: integer("max_lifetime_ms").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    principalKind: text("principal_kind", { enum: ["user", "apiKey", "anonymous"] }).notNull(),
    principalId: text("principal_id"),
    action: text("action").notNull(),
    target: text("target"),
    ip: text("ip"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown> | null>(),
  },
  (table) => [index("audit_log_at_idx").on(table.at)],
);

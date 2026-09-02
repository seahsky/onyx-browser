import { z } from "zod";

export class ConfigError extends Error {}

export interface Config {
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
  port: number;
  host: string;
  /** Origin only (scheme + host + port), no trailing slash. Feed to publicUrl(), never concatenate directly. */
  publicOrigin: string;
  databaseUrl: string;
  sessionSecret: string;
  adminEmail: string | null;
  adminPassword: string | null;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
  sessionMaxLifetimeMs: number;
  allowPrivateNetwork: boolean;
  chromeExecutablePath: string | null;
}

function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
  ctx: z.RefinementCtx,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    ctx.addIssue({ code: "custom", path: [name], message: `must be a positive integer, got "${raw}"` });
    return fallback;
  }
  return n;
}

function parseBooleanEnv(
  raw: string | undefined,
  fallback: boolean,
  name: string,
  ctx: z.RefinementCtx,
): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  ctx.addIssue({ code: "custom", path: [name], message: `must be "true" or "false", got "${raw}"` });
  return fallback;
}

const rawEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  ONYX_PUBLIC_URL: z.string().optional(),
  PORT: z.string().optional(),
  HOST: z.string().optional(),
  ONYX_DATABASE_URL: z.string().optional(),
  ONYX_SESSION_SECRET: z.string().optional(),
  ONYX_ADMIN_EMAIL: z.string().optional(),
  ONYX_ADMIN_PASSWORD: z.string().optional(),
  ONYX_MAX_CONCURRENT_SESSIONS: z.string().optional(),
  ONYX_SESSION_IDLE_TIMEOUT_MS: z.string().optional(),
  ONYX_SESSION_MAX_LIFETIME_MS: z.string().optional(),
  ONYX_ALLOW_PRIVATE_NETWORK: z.string().optional(),
  ONYX_CHROME_EXECUTABLE_PATH: z.string().optional(),
});

const configSchema = rawEnvSchema.transform((env, ctx): Config => {
  const nodeEnv = env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  const isProduction = nodeEnv === "production";

  const port = parsePositiveIntEnv(env.PORT, 3000, "PORT", ctx);
  const host = env.HOST ?? "0.0.0.0";

  let publicOrigin = "";
  if (env.ONYX_PUBLIC_URL) {
    try {
      publicOrigin = new URL(env.ONYX_PUBLIC_URL).origin;
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["ONYX_PUBLIC_URL"],
        message: `must be a full absolute URL (e.g. "https://onyx.example.com"), got "${env.ONYX_PUBLIC_URL}"`,
      });
    }
  } else if (isProduction) {
    ctx.addIssue({
      code: "custom",
      path: ["ONYX_PUBLIC_URL"],
      message:
        "is required in production — the server needs to know its own public origin to build websocketUrl and viewer links",
    });
  } else {
    publicOrigin = `http://localhost:${port}`;
  }

  const databaseUrl = env.ONYX_DATABASE_URL ?? "file:./data/onyx.db";

  const sessionSecret = env.ONYX_SESSION_SECRET ?? "";
  if (!env.ONYX_SESSION_SECRET) {
    ctx.addIssue({ code: "custom", path: ["ONYX_SESSION_SECRET"], message: "is required" });
  } else if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    ctx.addIssue({
      code: "custom",
      path: ["ONYX_SESSION_SECRET"],
      message: `must be at least 32 bytes, got ${Buffer.byteLength(sessionSecret, "utf8")}`,
    });
  }

  return {
    nodeEnv,
    isProduction,
    port,
    host,
    publicOrigin,
    databaseUrl,
    sessionSecret,
    adminEmail: env.ONYX_ADMIN_EMAIL ?? null,
    adminPassword: env.ONYX_ADMIN_PASSWORD ?? null,
    maxConcurrentSessions: parsePositiveIntEnv(env.ONYX_MAX_CONCURRENT_SESSIONS, 5, "ONYX_MAX_CONCURRENT_SESSIONS", ctx),
    sessionIdleTimeoutMs: parsePositiveIntEnv(
      env.ONYX_SESSION_IDLE_TIMEOUT_MS,
      300_000,
      "ONYX_SESSION_IDLE_TIMEOUT_MS",
      ctx,
    ),
    sessionMaxLifetimeMs: parsePositiveIntEnv(
      env.ONYX_SESSION_MAX_LIFETIME_MS,
      1_800_000,
      "ONYX_SESSION_MAX_LIFETIME_MS",
      ctx,
    ),
    allowPrivateNetwork: parseBooleanEnv(env.ONYX_ALLOW_PRIVATE_NETWORK, false, "ONYX_ALLOW_PRIVATE_NETWORK", ctx),
    chromeExecutablePath: env.ONYX_CHROME_EXECUTABLE_PATH ?? null,
  };
});

/**
 * Validates process.env into a Config, or throws ConfigError naming every
 * invalid/missing variable. Never falls back to a default for a variable
 * that is required in the current environment (see the required column in
 * the build spec's Configuration table).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "config"}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

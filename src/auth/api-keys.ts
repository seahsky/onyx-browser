import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import type { ApiScope } from "./scopes.js";
import type { Principal } from "./types.js";

const KEY_PREFIX = "onyx_";
const KEY_ID_BYTES = 6; // -> 12 hex chars, no separators, so "_" unambiguously splits keyId from secret
const SECRET_BYTES = 32;

export interface GeneratedApiKey {
  keyId: string;
  secret: string;
  /** The value shown to the caller exactly once. Never stored. */
  fullKey: string;
}

export function generateApiKey(): GeneratedApiKey {
  const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { keyId, secret, fullKey: `${KEY_PREFIX}${keyId}_${secret}` };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function parseApiKey(fullKey: string): { keyId: string; secret: string } | null {
  if (!fullKey.startsWith(KEY_PREFIX)) return null;
  const rest = fullKey.slice(KEY_PREFIX.length);
  const keyIdLength = KEY_ID_BYTES * 2;
  const keyId = rest.slice(0, keyIdLength);
  if (rest[keyIdLength] !== "_") return null;
  const secret = rest.slice(keyIdLength + 1);
  if (!/^[0-9a-f]+$/.test(keyId) || keyId.length !== keyIdLength || secret.length === 0) return null;
  return { keyId, secret };
}

/**
 * Looks up by keyId only, then constant-time compares the secret's hash —
 * never queries by the secret itself.
 */
export async function authenticateApiKey(db: Db, fullKey: string): Promise<Principal | null> {
  const parsed = parseApiKey(fullKey);
  if (!parsed) return null;

  const row = db.select().from(apiKeys).where(eq(apiKeys.keyId, parsed.keyId)).get();
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  const expected = Buffer.from(row.secretHash, "hex");
  const actual = Buffer.from(hashSecret(parsed.secret), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).run();

  return { kind: "apiKey", keyId: row.keyId, scopes: row.scopes as ApiScope[] };
}

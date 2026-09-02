import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { users } from "../db/schema.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { hashPassword } from "./password.js";

export class BootstrapError extends Error {}

const DENYLISTED_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "qwerty123",
  "admin1234",
  "administrator",
  "letmein123",
  "changeme123",
  "changeit123",
  "welcome123",
  "onyxadmin1",
]);

function assertPasswordAllowed(password: string): void {
  if (password.length < 12) {
    throw new BootstrapError("password must be at least 12 characters");
  }
  if (DENYLISTED_PASSWORDS.has(password.toLowerCase())) {
    throw new BootstrapError("password is too common — choose something less guessable");
  }
}

// In-process only, by design: a setup token is only ever meant to bridge a
// single first-boot-to-first-admin gap, not to survive a restart.
let pendingSetupToken: string | null = null;

export function getPendingSetupToken(): string | null {
  return pendingSetupToken;
}

/** Test-only: clears bootstrap module state between isolated test cases. */
export function resetBootstrapStateForTests(): void {
  pendingSetupToken = null;
}

function hasAnyUser(db: Db): boolean {
  return db.select({ id: users.id }).from(users).limit(1).all().length > 0;
}

export async function runBootstrap(db: Db, config: Config, logger: FastifyBaseLogger): Promise<void> {
  if (hasAnyUser(db)) {
    pendingSetupToken = null;
    return;
  }

  if (config.adminEmail && config.adminPassword) {
    assertPasswordAllowed(config.adminPassword);
    const passwordHash = await hashPassword(config.adminPassword);
    db.insert(users)
      .values({ email: config.adminEmail.trim().toLowerCase(), passwordHash, role: "admin" })
      .run();
    logger.info({ email: config.adminEmail }, "bootstrap: created initial admin from ONYX_ADMIN_EMAIL/ONYX_ADMIN_PASSWORD");
    return;
  }

  pendingSetupToken = randomBytes(24).toString("base64url");
  // Deliberately console.log, not the structured logger: this needs to be
  // unmistakable in a fresh container's stdout, not one line among many.
  // eslint-disable-next-line no-console -- see comment above
  console.log(
    [
      "",
      "Onyx: no admin account exists yet.",
      "Complete setup by POSTing to /setup with this one-time token:",
      "",
      `  ${pendingSetupToken}`,
      "",
    ].join("\n"),
  );
}

export async function completeSetup(
  db: Db,
  token: string,
  email: string,
  password: string,
): Promise<{ id: string; email: string }> {
  if (!pendingSetupToken || token !== pendingSetupToken) {
    throw new BootstrapError("setup token is invalid, already used, or setup was already completed");
  }
  if (hasAnyUser(db)) {
    pendingSetupToken = null;
    throw new BootstrapError("setup token is invalid, already used, or setup was already completed");
  }

  assertPasswordAllowed(password);
  const passwordHash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();

  const [created] = db
    .insert(users)
    .values({ email: normalizedEmail, passwordHash, role: "admin" })
    .returning({ id: users.id, email: users.email })
    .all();

  pendingSetupToken = null;
  return created!;
}

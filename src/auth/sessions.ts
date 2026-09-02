import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { userSessions, users } from "../db/schema.js";
import type { Principal } from "./types.js";

export const SESSION_COOKIE_NAME = "onyx_session";

// Not the same knobs as ONYX_SESSION_IDLE_TIMEOUT_MS / ONYX_SESSION_MAX_LIFETIME_MS
// in Config — those govern browser_sessions (Chrome instances, milestone M3).
// Login sessions get their own, longer-lived defaults; there is no env var
// for them because the build spec's config table doesn't list one.
const LOGIN_IDLE_MS = 24 * 60 * 60 * 1000; // 24h of inactivity
const LOGIN_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CreatedSession {
  id: string;
  absoluteExpiresAt: Date;
}

export function createSession(
  db: Db,
  userId: string,
  ip: string | null,
  userAgent: string | null,
): CreatedSession {
  const now = Date.now();
  const id = randomBytes(32).toString("base64url");
  const absoluteExpiresAt = new Date(now + LOGIN_ABSOLUTE_MS);

  db.insert(userSessions)
    .values({
      id,
      userId,
      expiresAt: new Date(now + LOGIN_IDLE_MS),
      absoluteExpiresAt,
      ip,
      userAgent,
    })
    .run();

  return { id, absoluteExpiresAt };
}

export function setSessionCookie(reply: FastifyReply, session: CreatedSession, config: Config): void {
  reply.setCookie(SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    secure: config.publicOrigin.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    signed: true,
    expires: session.absoluteExpiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

/** Validates a session id, sliding its idle expiry forward on success. */
export function authenticateSessionCookie(db: Db, sessionId: string): Principal | null {
  const session = db.select().from(userSessions).where(eq(userSessions.id, sessionId)).get();
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt.getTime() < now || session.absoluteExpiresAt.getTime() < now) {
    db.delete(userSessions).where(eq(userSessions.id, sessionId)).run();
    return null;
  }

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user || user.disabledAt) return null;

  const newExpiresAt = new Date(Math.min(now + LOGIN_IDLE_MS, session.absoluteExpiresAt.getTime()));
  db.update(userSessions).set({ expiresAt: newExpiresAt }).where(eq(userSessions.id, sessionId)).run();

  return { kind: "user", userId: user.id, sessionId: session.id, role: user.role };
}

export function revokeSession(db: Db, sessionId: string): void {
  db.delete(userSessions).where(eq(userSessions.id, sessionId)).run();
}

import type { FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { authenticateApiKey } from "./api-keys.js";
import { authenticateSessionCookie, SESSION_COOKIE_NAME } from "./sessions.js";
import type { Principal } from "./types.js";

export type { Principal } from "./types.js";

/**
 * Resolves the one Principal type from whichever credential is present:
 * Authorization: Bearer always carries an API key, the signed cookie always
 * carries a user session. An explicit Authorization header takes precedence
 * over a cookie when both are somehow present. Does not consider the
 * ?apiKey= query param — that path exists only for the CDP WebSocket
 * upgrade route and is handled there.
 */
export async function resolvePrincipal(request: FastifyRequest, db: Db): Promise<Principal | null> {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    return await authenticateApiKey(db, token);
  }

  const cookieValue = request.cookies[SESSION_COOKIE_NAME];
  if (cookieValue) {
    const unsigned = request.unsignCookie(cookieValue);
    if (!unsigned.valid || !unsigned.value) return null;
    return authenticateSessionCookie(db, unsigned.value);
  }

  return null;
}

/**
 * Narrows request.principal to the "user" variant. Only call this from a
 * route guarded by app.requireUserSession — the throw is a programming-bug
 * signal (misplaced guard), not a user-facing error path.
 */
export function requireUserPrincipal(request: FastifyRequest): Extract<Principal, { kind: "user" }> {
  if (!request.principal || request.principal.kind !== "user") {
    throw new Error("expected a user principal — route must be guarded by requireUserSession");
  }
  return request.principal;
}

/**
 * Asserts request.principal is non-null, for routes guarded by requireAuth
 * or requireScope. Same bug-signal contract as requireUserPrincipal.
 */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new Error("expected a principal — route must be guarded by requireAuth or requireScope");
  }
  return request.principal;
}

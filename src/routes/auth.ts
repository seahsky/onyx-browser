import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { countRecentLoginFailures, recordAudit } from "../auth/audit.js";
import { BootstrapError, completeSetup } from "../auth/bootstrap.js";
import { getDummyHash, verifyPassword } from "../auth/password.js";
import { requireUserPrincipal } from "../auth/principal.js";
import { clearSessionCookie, createSession, revokeSession, setSessionCookie } from "../auth/sessions.js";
import { users } from "../db/schema.js";
import { errorSchema } from "../schemas/common.js";

const LOGIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const roleSchema = z.enum(["admin", "user"]);

const userResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
});

const meResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), email: z.string(), role: roleSchema }),
  z.object({ kind: z.literal("apiKey"), keyId: z.string(), scopes: z.array(z.string()) }),
]);

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/v1/auth/login",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: z.object({ email: z.string().email(), password: z.string().min(1) }),
        response: { 200: userResponseSchema, 401: errorSchema },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const normalizedEmail = email.trim().toLowerCase();
      const ip = request.ip;

      const locked = countRecentLoginFailures(app.db, normalizedEmail, LOGIN_LOCKOUT_WINDOW_MS) >= LOGIN_MAX_FAILURES;

      const user = app.db.select().from(users).where(eq(users.email, normalizedEmail)).get();
      // Always run a real scrypt verify, even for an unknown email, so the
      // response takes the same time either way.
      const storedHash = user?.passwordHash ?? (await getDummyHash());
      const passwordOk = await verifyPassword(password, storedHash);

      const success = Boolean(user) && !user?.disabledAt && passwordOk && !locked;

      if (!success || !user) {
        recordAudit(app.db, {
          principalKind: "anonymous",
          action: "auth.login.failure",
          target: normalizedEmail,
          ip,
          detail: { reason: !user ? "unknown_email" : locked ? "rate_limited" : "bad_password" },
        });
        return reply.code(401).send({ error: "invalid_credentials", message: "Invalid email or password." });
      }

      const session = createSession(app.db, user.id, ip, request.headers["user-agent"] ?? null);
      setSessionCookie(reply, session, app.config);

      recordAudit(app.db, {
        principalKind: "user",
        principalId: user.id,
        action: "auth.login.success",
        target: normalizedEmail,
        ip,
      });

      return reply.send({ id: user.id, email: user.email, role: user.role });
    },
  );

  typed.post(
    "/v1/auth/logout",
    {
      preHandler: app.requireUserSession,
      schema: { response: { 204: z.null() } },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request);
      revokeSession(app.db, principal.sessionId);
      recordAudit(app.db, {
        principalKind: "user",
        principalId: principal.userId,
        action: "auth.logout",
        ip: request.ip,
      });
      clearSessionCookie(reply);
      return reply.code(204).send(null);
    },
  );

  typed.get(
    "/v1/auth/me",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: meResponseSchema, 401: errorSchema } },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) {
        return reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
      }
      if (principal.kind === "user") {
        const user = app.db.select().from(users).where(eq(users.id, principal.userId)).get();
        if (!user) {
          return reply.code(401).send({ error: "unauthorized", message: "Session user no longer exists." });
        }
        return reply.send({ kind: "user", id: user.id, email: user.email, role: user.role });
      }
      return reply.send({ kind: "apiKey", keyId: principal.keyId, scopes: principal.scopes });
    },
  );

  // Not listed in the build spec's /v1 API surface table, but the Bootstrap
  // section explicitly describes this route ("serve /setup which accepts
  // that token once"). Kept at the top level, outside /v1, to match that
  // description rather than silently folding it into /v1/auth.
  typed.post(
    "/setup",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: z.object({ token: z.string().min(1), email: z.string().email(), password: z.string().min(1) }),
        response: { 200: z.object({ id: z.string(), email: z.string() }), 400: errorSchema },
      },
    },
    async (request, reply) => {
      const { token, email, password } = request.body;
      try {
        const created = await completeSetup(app.db, token, email, password);
        recordAudit(app.db, {
          principalKind: "user",
          principalId: created.id,
          action: "auth.setup.completed",
          target: created.email,
          ip: request.ip,
        });
        return reply.send(created);
      } catch (err) {
        if (err instanceof BootstrapError) {
          return reply.code(400).send({ error: "invalid_setup", message: err.message });
        }
        throw err;
      }
    },
  );
}

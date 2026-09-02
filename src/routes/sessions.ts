import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../auth/principal.js";
import { ConcurrencyLimitError } from "../browser/manager.js";
import { browserSessions } from "../db/schema.js";
import { errorSchema } from "../schemas/common.js";
import { toWebSocketUrl } from "../url.js";

const sessionStatusSchema = z.enum(["starting", "running", "releasing", "released", "crashed"]);

const sessionSummarySchema = z.object({
  id: z.string(),
  status: sessionStatusSchema,
  createdAt: z.string(),
  releasedAt: z.string().nullable(),
  expiresAt: z.string(),
});

const sessionCreateResponseSchema = z.object({
  id: z.string(),
  websocketUrl: z.string(),
  viewerUrl: z.string(),
  expiresAt: z.string(),
});

function toSummary(row: typeof browserSessions.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    releasedAt: row.releasedAt?.toISOString() ?? null,
    expiresAt: new Date(row.createdAt.getTime() + row.maxLifetimeMs).toISOString(),
  };
}

// No multi-tenancy, and the concurrency cap is a shared resource pool, so
// any authenticated principal can see every session (not just their own) —
// closer to "docker ps" than to a private inbox. Releasing someone else's
// session is more disruptive, though, so DELETE is restricted to the
// creator or an admin.
export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/v1/sessions",
    {
      onRequest: app.requireScope("sessions:write"),
      schema: { response: { 201: sessionCreateResponseSchema, 429: errorSchema } },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);

      try {
        const result = await app.browserSessions.create(principal);
        const websocketUrl = toWebSocketUrl(app.publicUrl(`/v1/cdp/${result.id}`));
        const viewerUrl = toWebSocketUrl(app.publicUrl(`/v1/sessions/${result.id}/viewer`));
        return reply.code(201).send({
          id: result.id,
          websocketUrl,
          viewerUrl,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          return reply.code(429).send({ error: "at_capacity", message: err.message });
        }
        throw err;
      }
    },
  );

  typed.get(
    "/v1/sessions",
    {
      onRequest: app.requireScope("sessions:read"),
      schema: { response: { 200: z.array(sessionSummarySchema) } },
    },
    async (_request, reply) => {
      const rows = app.db.select().from(browserSessions).orderBy(desc(browserSessions.createdAt)).all();
      return reply.send(rows.map(toSummary));
    },
  );

  typed.get(
    "/v1/sessions/:id",
    {
      onRequest: app.requireScope("sessions:read"),
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: sessionSummarySchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const row = app.db.select().from(browserSessions).where(eq(browserSessions.id, request.params.id)).get();
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });
      return reply.send(toSummary(row));
    },
  );

  typed.delete(
    "/v1/sessions/:id",
    {
      onRequest: app.requireScope("sessions:write"),
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 403: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);

      const row = app.db.select().from(browserSessions).where(eq(browserSessions.id, request.params.id)).get();
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such session." });

      const isOwner =
        (principal.kind === "user" && row.createdByKind === "user" && row.createdById === principal.userId) ||
        (principal.kind === "apiKey" && row.createdByKind === "apiKey" && row.createdById === principal.keyId);
      const isAdmin = principal.kind === "user" && principal.role === "admin";

      if (!isOwner && !isAdmin) {
        return reply.code(403).send({ error: "forbidden", message: "You may only release sessions you created." });
      }

      const released = await app.browserSessions.release(row.id, principal);
      if (!released) {
        // Timed out or crashed between the SELECT above and this call.
        return reply.code(404).send({ error: "not_found", message: "No such session." });
      }
      return reply.code(204).send(null);
    },
  );
}

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { generateApiKey, hashSecret } from "../auth/api-keys.js";
import { recordAudit } from "../auth/audit.js";
import { requireUserPrincipal } from "../auth/principal.js";
import { API_SCOPES, type ApiScope } from "../auth/scopes.js";
import { apiKeys } from "../db/schema.js";
import { errorSchema } from "../schemas/common.js";

const keyMetadataSchema = z.object({
  id: z.string(),
  keyId: z.string(),
  label: z.string(),
  scopes: z.array(z.enum(API_SCOPES)),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

function toMetadata(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    keyId: row.keyId,
    label: row.label,
    // Always drawn from API_SCOPES: the only writer is POST /v1/keys, whose
    // body schema validates scopes against that same enum.
    scopes: row.scopes as ApiScope[],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

// Key management is never reachable by an API key, only a user session —
// and scoped to the caller's own keys. There is no cross-user key listing;
// the build spec doesn't ask for one and this is a single-admin-plus-a-few-
// users deployment, not a multi-tenant one.
export async function registerKeyRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/v1/keys",
    {
      onRequest: app.requireUserSession,
      schema: { response: { 200: z.array(keyMetadataSchema) } },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request);
      const rows = app.db.select().from(apiKeys).where(eq(apiKeys.ownerId, principal.userId)).all();
      return reply.send(rows.map(toMetadata));
    },
  );

  typed.post(
    "/v1/keys",
    {
      onRequest: app.requireUserSession,
      schema: {
        body: z.object({
          label: z.string().min(1).max(200),
          scopes: z.array(z.enum(API_SCOPES)).min(1),
          expiresAt: z.string().datetime().nullable().optional(),
        }),
        response: { 200: keyMetadataSchema.extend({ key: z.string() }) },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request);
      const { label, scopes, expiresAt } = request.body;
      const generated = generateApiKey();

      const [row] = app.db
        .insert(apiKeys)
        .values({
          keyId: generated.keyId,
          secretHash: hashSecret(generated.secret),
          label,
          scopes,
          ownerId: principal.userId,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        })
        .returning()
        .all();

      recordAudit(app.db, {
        principalKind: "user",
        principalId: principal.userId,
        action: "apiKey.create",
        target: generated.keyId,
        ip: request.ip,
        detail: { label, scopes },
      });

      return reply.send({ ...toMetadata(row!), key: generated.fullKey });
    },
  );

  typed.delete(
    "/v1/keys/:keyId",
    {
      onRequest: app.requireUserSession,
      schema: {
        params: z.object({ keyId: z.string() }),
        response: { 204: z.null(), 404: errorSchema },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request);
      const { keyId } = request.params;

      const row = app.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyId, keyId), eq(apiKeys.ownerId, principal.userId)))
        .get();

      if (!row || row.revokedAt) {
        return reply.code(404).send({ error: "not_found", message: "No such API key." });
      }

      app.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id)).run();

      recordAudit(app.db, {
        principalKind: "user",
        principalId: principal.userId,
        action: "apiKey.revoke",
        target: keyId,
        ip: request.ip,
      });

      return reply.code(204).send(null);
    },
  );
}

import cookie from "@fastify/cookie";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ApiScope } from "../auth/scopes.js";
import { resolvePrincipal } from "../auth/principal.js";

const authPlugin: FastifyPluginAsync = async (app) => {
  await app.register(cookie, {
    secret: app.config.sessionSecret,
  });

  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (request) => {
    request.principal = await resolvePrincipal(request, app.db);
  });

  app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.principal) {
      await reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
    }
  });

  app.decorate("requireUserSession", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.principal || request.principal.kind !== "user") {
      await reply.code(401).send({ error: "unauthorized", message: "A user session is required." });
    }
  });

  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.principal || request.principal.kind !== "user" || request.principal.role !== "admin") {
      await reply.code(403).send({ error: "forbidden", message: "Admin role required." });
    }
  });

  app.decorate("requireScope", (scope: ApiScope) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.principal) {
        await reply.code(401).send({ error: "unauthorized", message: "Authentication required." });
        return;
      }
      if (request.principal.kind === "apiKey" && !request.principal.scopes.includes(scope)) {
        await reply.code(403).send({ error: "forbidden", message: `Missing required scope: ${scope}` });
      }
    };
  });
};

export default fp(authPlugin, { name: "auth" });

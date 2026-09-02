import "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import type { Principal } from "../auth/types.js";
import type { ApiScope } from "../auth/scopes.js";
import type { RouteInventoryEntry } from "../server.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    publicUrl: (path: string) => string;
    routeInventory: RouteInventoryEntry[];
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireUserSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireScope: (scope: ApiScope) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    principal: Principal | null;
  }
}

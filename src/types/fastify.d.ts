import "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    publicUrl: (path: string) => string;
  }
}

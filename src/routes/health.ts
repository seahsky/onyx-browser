import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

// Liveness only — no version, uptime, or dependency status. Unauthenticated,
// so it must never leak anything about the deployment.
export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/health",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ok") }),
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );
}

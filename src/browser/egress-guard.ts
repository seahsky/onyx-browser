import type { FastifyBaseLogger } from "fastify";
import { recordAudit } from "../auth/audit.js";
import type { Db } from "../db/index.js";
import { evaluateEgress } from "../egress/policy.js";
import { connectCdpClient, type CdpClient } from "./cdp-client.js";
import { discoverBrowserWsEndpoint } from "./cdp-discovery.js";

export interface EgressGuardHandle {
  close(): void;
}

interface TargetAttachedParams {
  sessionId: string;
}

interface FetchRequestPausedParams {
  requestId: string;
  request: { url: string };
}

/**
 * Attaches a supervisory CDP connection to a browser session that intercepts
 * every request on every target (current and future) and enforces the
 * scheme/address denylist before Chrome is allowed to send it — independent
 * of whatever the external client connected through the M4 proxy does. This
 * is Onyx's own connection, separate from the external client's.
 */
export async function attachEgressGuard(
  cdpPort: number,
  browserSessionId: string,
  db: Db,
  allowPrivateNetwork: boolean,
  logger: FastifyBaseLogger,
): Promise<EgressGuardHandle> {
  const wsUrl = await discoverBrowserWsEndpoint(cdpPort);
  const client = await connectCdpClient(wsUrl);

  async function setupTarget(targetSessionId: string): Promise<void> {
    await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, targetSessionId);
    await client.send("Runtime.runIfWaitingForDebugger", {}, targetSessionId);
  }

  client.on("Target.attachedToTarget", (rawParams) => {
    const { sessionId: targetSessionId } = rawParams as TargetAttachedParams;
    void setupTarget(targetSessionId).catch((err: unknown) => {
      logger.warn({ err, browserSessionId }, "egress guard: failed to attach to a new target");
    });
  });

  client.on("Fetch.requestPaused", (rawParams, targetSessionId) => {
    if (!targetSessionId) return;
    const { requestId, request } = rawParams as FetchRequestPausedParams;
    void handlePausedRequest(client, targetSessionId, requestId, request.url).catch((err: unknown) => {
      logger.warn({ err, browserSessionId, url: request.url }, "egress guard: error handling a paused request");
    });
  });

  async function handlePausedRequest(
    cdp: CdpClient,
    targetSessionId: string,
    requestId: string,
    url: string,
  ): Promise<void> {
    const decision = await evaluateEgress(url, allowPrivateNetwork);

    if (!decision.allowed) {
      recordAudit(db, {
        principalKind: "anonymous",
        action: "egress.denied",
        target: browserSessionId,
        detail: { url, reason: decision.reason, resolvedAddresses: decision.resolvedAddresses },
      });
      logger.warn({ browserSessionId, url, reason: decision.reason }, "egress guard: blocked a request");
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, targetSessionId).catch(() => {});
      return;
    }

    await cdp.send("Fetch.continueRequest", { requestId }, targetSessionId).catch(() => {});
  }

  // waitForDebuggerOnStart pauses every new target (including ones that
  // exist already) until Runtime.runIfWaitingForDebugger releases it, which
  // setupTarget only calls after Fetch.enable is in place — so a target's
  // very first request is intercepted too, not just its second and later.
  await client.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  return {
    close(): void {
      client.close();
    },
  };
}

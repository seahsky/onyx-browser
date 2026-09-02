import type { FastifyBaseLogger } from "fastify";
import type { WebSocket as WsWebSocket } from "ws";
import { connectCdpClient } from "./cdp-client.js";
import { discoverBrowserWsEndpoint } from "./cdp-discovery.js";

interface TargetInfo {
  targetId: string;
  type: string;
}

interface AttachedToTargetParams {
  sessionId: string;
  targetInfo: TargetInfo;
}

interface ScreencastFrameParams {
  data: string;
  sessionId: number;
}

export interface ScreencastHandle {
  close(): void;
}

/**
 * Read-only: streams Page.startScreencast JPEG frames as
 * {"type":"frame","data":"<base64>"} text messages. Never a full CDP
 * relay — see build spec open question #2. If the session has no page yet
 * (nothing has navigated through the M4 CDP proxy), creates a blank one so
 * the viewer always has something to show.
 */
export async function streamScreencast(
  cdpPort: number,
  clientSocket: WsWebSocket,
  logger: FastifyBaseLogger,
): Promise<ScreencastHandle> {
  const wsUrl = await discoverBrowserWsEndpoint(cdpPort);
  const client = await connectCdpClient(wsUrl);

  let attached = false;

  async function attachToTarget(targetSessionId: string): Promise<void> {
    if (attached) return;
    attached = true;
    await client.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 }, targetSessionId);
  }

  client.on("Target.attachedToTarget", (rawParams) => {
    const { sessionId: targetSessionId, targetInfo } = rawParams as AttachedToTargetParams;
    if (targetInfo.type !== "page") return;
    void attachToTarget(targetSessionId).catch((err: unknown) => {
      logger.warn({ err }, "screencast: failed to start on an attached target");
    });
  });

  client.on("Page.screencastFrame", (rawParams, targetSessionId) => {
    const { data, sessionId: frameAckId } = rawParams as ScreencastFrameParams;
    if (clientSocket.readyState === clientSocket.OPEN) {
      clientSocket.send(JSON.stringify({ type: "frame", data }));
    }
    if (targetSessionId) {
      void client.send("Page.screencastFrameAck", { sessionId: frameAckId }, targetSessionId).catch(() => {});
    }
  });

  await client.send("Target.setDiscoverTargets", { discover: true });
  await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const targets = (await client.send("Target.getTargets", {})) as { targetInfos: TargetInfo[] };
  if (!targets.targetInfos.some((t) => t.type === "page")) {
    await client.send("Target.createTarget", { url: "about:blank" });
  }

  return {
    close(): void {
      client.close();
    },
  };
}

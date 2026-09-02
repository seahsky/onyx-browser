import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { authenticateApiKey } from "../auth/api-keys.js";
import { discoverBrowserWsEndpoint } from "../browser/cdp-discovery.js";

interface CdpParams {
  sessionId: string;
}

// The only route where ?apiKey= is accepted: some CDP clients (raw
// Playwright/Puppeteer/Selenium drivers) cannot set headers on a WebSocket
// upgrade request. The query param never reaches other routes, and the
// logger's req serializer strips it from access logs.
async function resolveViaQueryApiKey(request: FastifyRequest, app: FastifyInstance): Promise<void> {
  if (request.principal) return;
  const apiKeyParam = (request.query as { apiKey?: string }).apiKey;
  if (!apiKeyParam) return;
  request.principal = await authenticateApiKey(app.db, apiKeyParam);
}

export async function registerCdpRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: CdpParams }>(
    "/v1/cdp/:sessionId",
    {
      websocket: true,
      onRequest: [async (request) => resolveViaQueryApiKey(request, app), app.requireScope("cdp:connect")],
    },
    (clientSocket, request) => {
      const { sessionId } = request.params;
      const cdpPort = app.browserSessions.getCdpPort(sessionId);

      if (cdpPort === null) {
        clientSocket.close(4004, "no such session");
        return;
      }

      let upstream: WebSocket | undefined;
      let closed = false;

      const closeBoth = (): void => {
        if (closed) return;
        closed = true;
        if (clientSocket.readyState === clientSocket.OPEN) clientSocket.close();
        if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
          upstream.close();
        }
      };

      // CDP frames are text (JSON). ws's "message" event hands back a
      // Buffer regardless of frame type, so the isBinary flag has to be
      // forwarded explicitly on both legs — send(buffer) alone defaults to
      // a binary frame, and Chrome's CDP server + Playwright's own client
      // both care about the difference.
      const pending: Array<{ data: Buffer; isBinary: boolean }> = [];
      clientSocket.on("message", (data: Buffer, isBinary: boolean) => {
        app.browserSessions.touch(sessionId);
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        } else {
          pending.push({ data, isBinary });
        }
      });
      clientSocket.on("close", closeBoth);
      clientSocket.on("error", closeBoth);

      discoverBrowserWsEndpoint(cdpPort)
        .then((upstreamUrl) => {
          if (closed) return;
          upstream = new WebSocket(upstreamUrl);

          upstream.on("open", () => {
            for (const message of pending.splice(0)) upstream?.send(message.data, { binary: message.isBinary });
          });
          upstream.on("message", (data: Buffer, isBinary: boolean) => {
            if (clientSocket.readyState === clientSocket.OPEN) clientSocket.send(data, { binary: isBinary });
          });
          upstream.on("close", closeBoth);
          upstream.on("error", (err) => {
            app.log.warn({ err, sessionId }, "upstream CDP connection error");
            closeBoth();
          });
        })
        .catch((err: unknown) => {
          app.log.warn({ err, sessionId }, "CDP discovery failed");
          if (!closed) {
            closed = true;
            clientSocket.close(1011, "upstream unavailable");
          }
        });
    },
  );
}

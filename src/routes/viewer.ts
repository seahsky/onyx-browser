import type { FastifyInstance } from "fastify";
import { streamScreencast } from "../browser/screencast.js";

interface ViewerParams {
  id: string;
}

// Cookie-only, per the build spec's auth surface table — no bearer, no
// ?apiKey=. This is a browser-facing UI feature, not a programmatic one.
export async function registerViewerRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: ViewerParams }>(
    "/v1/sessions/:id/viewer",
    { websocket: true, onRequest: app.requireUserSession },
    (clientSocket, request) => {
      const { id: sessionId } = request.params;
      const cdpPort = app.browserSessions.getCdpPort(sessionId);

      if (cdpPort === null) {
        clientSocket.close(4004, "no such session");
        return;
      }

      streamScreencast(cdpPort, clientSocket, app.log)
        .then((handle) => {
          clientSocket.on("close", () => handle.close());
          clientSocket.on("error", () => handle.close());
        })
        .catch((err: unknown) => {
          app.log.warn({ err, sessionId }, "viewer: failed to start screencast");
          if (clientSocket.readyState === clientSocket.OPEN) {
            clientSocket.close(1011, "screencast unavailable");
          }
        });
    },
  );
}

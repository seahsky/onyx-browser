import { WebSocket } from "ws";

type CdpEventHandler = (params: unknown, sessionId?: string) => void;

export interface CdpClient {
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(event: string, handler: CdpEventHandler): void;
  close(): void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
}

/**
 * A deliberately minimal raw CDP JSON-RPC client — just enough to drive
 * Target.setAutoAttach + the Fetch domain for the egress guard. Not a
 * general-purpose CDP library; Onyx doesn't automate pages itself, external
 * clients do that through the M4 proxy.
 */
export function connectCdpClient(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    const listeners = new Map<string, Set<CdpEventHandler>>();

    ws.once("error", rejectConnect);
    ws.once("open", () => {
      ws.off("error", rejectConnect);

      ws.on("message", (raw: Buffer) => {
        let msg: CdpMessage;
        try {
          msg = JSON.parse(raw.toString()) as CdpMessage;
        } catch {
          return;
        }
        if (typeof msg.id === "number") {
          const waiter = pending.get(msg.id);
          if (!waiter) return;
          pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error.message ?? "CDP error"));
          else waiter.resolve(msg.result);
          return;
        }
        if (typeof msg.method === "string") {
          for (const handler of listeners.get(msg.method) ?? []) {
            handler(msg.params, msg.sessionId);
          }
        }
      });

      ws.on("error", () => {
        // Surfaced to callers as their pending send()/close events, not here.
      });

      resolveConnect({
        send(method, params = {}, sessionId) {
          return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        on(event, handler) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(handler);
        },
        close() {
          ws.close();
        },
      });
    });
  });
}

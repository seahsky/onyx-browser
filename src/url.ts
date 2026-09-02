import type { Config } from "./config.js";

/**
 * The only function allowed to concatenate the server's public origin onto a
 * path. Bound once at boot from Config.publicOrigin — never from HOST or an
 * incoming Host/X-Forwarded-Host header, which are a poisoning vector.
 */
export function createPublicUrl(config: Pick<Config, "publicOrigin">): (path: string) => string {
  return (path: string): string => {
    if (!path.startsWith("/")) {
      throw new Error(`publicUrl(path) requires an absolute path starting with "/", got "${path}"`);
    }
    return `${config.publicOrigin}${path}`;
  };
}

/** Derives a ws(s):// URL from an http(s):// one built by publicUrl(). */
export function toWebSocketUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  throw new Error(`toWebSocketUrl expects an http(s) URL, got "${httpUrl}"`);
}

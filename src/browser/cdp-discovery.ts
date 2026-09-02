/** Asks Chrome's own debugging HTTP endpoint for its browser-level CDP WebSocket URL. */
export async function discoverBrowserWsEndpoint(cdpPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  if (!response.ok) {
    throw new Error(`CDP discovery on port ${cdpPort} failed with status ${response.status}`);
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) {
    throw new Error(`CDP discovery on port ${cdpPort} returned no webSocketDebuggerUrl`);
  }
  return body.webSocketDebuggerUrl;
}

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildTestApp, createTestUser, type TestApp } from "./helpers/app.js";

const CHROME_EXECUTABLE_PATH = "/opt/pw-browsers/chromium";

function getCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  const value = match?.split(";")[0]?.split("=").slice(1).join("=");
  if (!value) throw new Error(`expected a ${name} cookie in the response`);
  return value;
}

describe("live viewer", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("streams at least one screencast frame over the viewer WebSocket", async () => {
    testApp = await buildTestApp({ ONYX_CHROME_EXECUTABLE_PATH: CHROME_EXECUTABLE_PATH });
    await testApp.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.app.server.address() as AddressInfo).port;

    const user = await createTestUser(testApp.db, { email: "viewer-user@example.com", password: "viewer-password-1" });
    const login = await testApp.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: "viewer-password-1" },
    });
    const cookie = getCookie(login.headers["set-cookie"], "onyx_session");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: cookie },
    });
    const { id: sessionId } = created.json();

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${sessionId}/viewer`, {
      headers: { Cookie: `onyx_session=${cookie}` },
    });

    const frame = await new Promise<{ type: string; data: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a screencast frame")), 15_000);
      client.on("message", (raw: Buffer) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
      client.on("error", reject);
    });

    expect(frame.type).toBe("frame");
    expect(frame.data.length).toBeGreaterThan(0);
    // A valid JPEG, base64-decoded, starts with the FFD8 marker.
    expect(Buffer.from(frame.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    client.close();
  }, 25_000);

  it("rejects the viewer connection with no credentials", async () => {
    testApp = await buildTestApp({ ONYX_CHROME_EXECUTABLE_PATH: CHROME_EXECUTABLE_PATH });
    await testApp.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.app.server.address() as AddressInfo).port;

    const user = await createTestUser(testApp.db, { email: "viewer-noauth@example.com", password: "viewer-password-2" });
    const login = await testApp.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: "viewer-password-2" },
    });
    const cookie = getCookie(login.headers["set-cookie"], "onyx_session");
    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: cookie },
    });
    const { id: sessionId } = created.json();

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${sessionId}/viewer`);
    const statusCode = await new Promise<number>((resolve, reject) => {
      client.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      client.on("open", () => reject(new Error("connection upgraded with no credentials")));
      client.on("error", reject);
    });
    expect(statusCode).toBe(401);
  }, 20_000);
});

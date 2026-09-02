import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
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

interface Fixture {
  testApp: TestApp;
  port: number;
  sessionId: string;
  apiKey: string;
}

/** Boots a real listening app, logs in, creates a cdp:connect key, and launches one browser session. */
async function buildFixture(scopes: string[] = ["sessions:write", "cdp:connect"]): Promise<Fixture> {
  const testApp = await buildTestApp({ ONYX_CHROME_EXECUTABLE_PATH: CHROME_EXECUTABLE_PATH });
  await testApp.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (testApp.app.server.address() as AddressInfo).port;

  const user = await createTestUser(testApp.db, { email: "cdp-user@example.com", password: "cdp-password-1" });
  const login = await testApp.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: user.email, password: "cdp-password-1" },
  });
  const cookie = getCookie(login.headers["set-cookie"], "onyx_session");

  const keyResponse = await testApp.app.inject({
    method: "POST",
    url: "/v1/keys",
    cookies: { onyx_session: cookie },
    payload: { label: "cdp test key", scopes },
  });
  const apiKey = keyResponse.json().key;

  const sessionResponse = await testApp.app.inject({
    method: "POST",
    url: "/v1/sessions",
    cookies: { onyx_session: cookie },
  });
  const sessionId = sessionResponse.json().id;

  return { testApp, port, sessionId, apiKey };
}

describe("CDP proxy", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("drives a real page through the proxy when connecting with a bearer header", async () => {
    const fixture = await buildFixture();
    testApp = fixture.testApp;

    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${fixture.port}/v1/cdp/${fixture.sessionId}`, {
      headers: { Authorization: `Bearer ${fixture.apiKey}` },
    });
    try {
      expect(browser.isConnected()).toBe(true);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      await page.goto("about:blank");
      expect(page.url()).toBe("about:blank");
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("rejects the same connectOverCDP call with no credentials at the upgrade", async () => {
    const fixture = await buildFixture();
    testApp = fixture.testApp;

    await expect(
      chromium.connectOverCDP(`ws://127.0.0.1:${fixture.port}/v1/cdp/${fixture.sessionId}`),
    ).rejects.toThrow();
  }, 20_000);

  it("rejects a bearer key that lacks the cdp:connect scope", async () => {
    const fixture = await buildFixture(["sessions:write", "sessions:read"]);
    testApp = fixture.testApp;

    await expect(
      chromium.connectOverCDP(`ws://127.0.0.1:${fixture.port}/v1/cdp/${fixture.sessionId}`, {
        headers: { Authorization: `Bearer ${fixture.apiKey}` },
      }),
    ).rejects.toThrow();
  }, 20_000);

  it("also accepts the key via the ?apiKey= query param, for clients that can't set headers", async () => {
    const fixture = await buildFixture();
    testApp = fixture.testApp;

    const browser = await chromium.connectOverCDP(
      `ws://127.0.0.1:${fixture.port}/v1/cdp/${fixture.sessionId}?apiKey=${encodeURIComponent(fixture.apiKey)}`,
    );
    try {
      expect(browser.isConnected()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("closes the connection for an unknown or already-released session", async () => {
    // A raw ws client, not connectOverCDP: playwright's client does its own
    // multi-step CDP handshake/discovery after the upgrade and doesn't
    // reject promptly on an abrupt post-upgrade close — the WS-level close
    // code is what this route actually controls, so assert that directly.
    const fixture = await buildFixture();
    testApp = fixture.testApp;

    const client = new WebSocket(`ws://127.0.0.1:${fixture.port}/v1/cdp/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${fixture.apiKey}` },
    });

    const closeEvent = await new Promise<{ code: number }>((resolve, reject) => {
      client.on("close", (code) => resolve({ code }));
      client.on("error", reject);
    });

    expect(closeEvent.code).toBe(4004);
  }, 20_000);
});

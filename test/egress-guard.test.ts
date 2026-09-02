import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { auditLog } from "../src/db/schema.js";
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

async function buildFixture(envOverrides: Record<string, string> = {}): Promise<Fixture> {
  const testApp = await buildTestApp({ ONYX_CHROME_EXECUTABLE_PATH: CHROME_EXECUTABLE_PATH, ...envOverrides });
  await testApp.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (testApp.app.server.address() as AddressInfo).port;

  const user = await createTestUser(testApp.db, { email: "egress-user@example.com", password: "egress-password-1" });
  const login = await testApp.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: user.email, password: "egress-password-1" },
  });
  const cookie = getCookie(login.headers["set-cookie"], "onyx_session");

  const keyResponse = await testApp.app.inject({
    method: "POST",
    url: "/v1/keys",
    cookies: { onyx_session: cookie },
    payload: { label: "egress test key", scopes: ["sessions:write", "cdp:connect"] },
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

async function connectAndGetPage(fixture: Fixture) {
  const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${fixture.port}/v1/cdp/${fixture.sessionId}`, {
    headers: { Authorization: `Bearer ${fixture.apiKey}` },
  });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  return { browser, page };
}

describe("egress control", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("blocks file:// navigation", async () => {
    const fixture = await buildFixture();
    testApp = fixture.testApp;
    const { browser, page } = await connectAndGetPage(fixture);
    try {
      await expect(page.goto("file:///etc/passwd")).rejects.toThrow();
    } finally {
      await browser.close();
    }

    const entries = testApp.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "egress.denied"))
      .all();
    expect(entries.some((e) => e.target === fixture.sessionId)).toBe(true);
  }, 20_000);

  it("blocks navigation to a loopback address", async () => {
    const fixture = await buildFixture();
    testApp = fixture.testApp;
    const { browser, page } = await connectAndGetPage(fixture);
    try {
      await expect(page.goto(`http://127.0.0.1:${fixture.port}/health`)).rejects.toThrow();
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("blocks navigation to the cloud metadata address", async () => {
    const fixture = await buildFixture();
    testApp = fixture.testApp;
    const { browser, page } = await connectAndGetPage(fixture);
    try {
      await expect(page.goto("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
    } finally {
      await browser.close();
    }

    const entries = testApp.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "egress.denied"))
      .all();
    const detail = entries.find((e) => e.target === fixture.sessionId)?.detail as { resolvedAddresses?: string[] } | null;
    expect(detail?.resolvedAddresses).toContain("169.254.169.254");
  }, 20_000);

  it("allows a normal public navigation through", async () => {
    const fixture = await buildFixture();
    testApp = fixture.testApp;
    const { browser, page } = await connectAndGetPage(fixture);
    try {
      await page.goto("about:blank");
      expect(page.url()).toBe("about:blank");
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("ONYX_ALLOW_PRIVATE_NETWORK=true allows a private address through but still blocks file://", async () => {
    const fixture = await buildFixture({ ONYX_ALLOW_PRIVATE_NETWORK: "true" });
    testApp = fixture.testApp;
    const { browser, page } = await connectAndGetPage(fixture);
    try {
      const response = await page.goto(`http://127.0.0.1:${fixture.port}/health`);
      expect(response?.ok()).toBe(true);
      await expect(page.goto("file:///etc/passwd")).rejects.toThrow();
    } finally {
      await browser.close();
    }
  }, 20_000);
});

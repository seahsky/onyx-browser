import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { auditLog } from "../src/db/schema.js";
import { buildTestApp, createTestUser, type TestApp } from "./helpers/app.js";

// This sandbox's pre-installed Chromium doesn't match the exact revision
// playwright-core's own default resolution expects, so tests must point at
// it explicitly. A production image (M7) installs a matching Chromium and
// leaves ONYX_CHROME_EXECUTABLE_PATH unset, relying on playwright-core's
// default resolution instead.
const CHROME_EXECUTABLE_PATH = "/opt/pw-browsers/chromium";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  const value = match?.split(";")[0]?.split("=").slice(1).join("=");
  if (!value) throw new Error(`expected a ${name} cookie in the response`);
  return value;
}

async function buildLoggedInApp(envOverrides: Record<string, string> = {}): Promise<{ testApp: TestApp; cookie: string }> {
  const testApp = await buildTestApp({ ONYX_CHROME_EXECUTABLE_PATH: CHROME_EXECUTABLE_PATH, ...envOverrides });
  const user = await createTestUser(testApp.db, { email: "browser-user@example.com", password: "browser-password-1" });
  const login = await testApp.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: user.email, password: "browser-password-1" },
  });
  const cookie = getCookie(login.headers["set-cookie"], "onyx_session");
  return { testApp, cookie };
}

describe("browser session lifecycle", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    // Every test's cleanup() closes the app, which fires the onClose hook
    // that calls browserSessions.closeAll() — this is also what makes "no
    // orphan Chrome process after the suite exits" hold suite-wide, not
    // just in this file: nothing here relies on an explicit release.
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("launches a real Chrome process on create and kills it on release", async () => {
    const logged = await buildLoggedInApp();
    testApp = logged.testApp;

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.id).toBeTruthy();
    expect(body.websocketUrl).toBe(`ws://localhost:${testApp.config.port}/v1/cdp/${body.id}`);
    expect(body.viewerUrl).toBe(`ws://localhost:${testApp.config.port}/v1/sessions/${body.id}/viewer`);

    const pid = testApp.app.browserSessions.getPid(body.id);
    expect(pid).toBeTypeOf("number");
    expect(isAlive(pid!)).toBe(true);
    expect(testApp.app.browserSessions.getCdpPort(body.id)).toBeTypeOf("number");

    const listed = await testApp.app.inject({
      method: "GET",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    expect(listed.json()).toContainEqual(expect.objectContaining({ id: body.id, status: "running" }));

    const released = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${body.id}`,
      cookies: { onyx_session: logged.cookie },
    });
    expect(released.statusCode).toBe(204);

    expect(testApp.app.browserSessions.getPid(body.id)).toBeNull();
    expect(isAlive(pid!)).toBe(false);

    const row = testApp.db.select().from(auditLog).where(eq(auditLog.action, "browserSession.released")).all();
    expect(row.some((r) => r.target === body.id)).toBe(true);
  }, 20_000);

  it("closes any still-active session when the app shuts down, even without an explicit release", async () => {
    const logged = await buildLoggedInApp();
    testApp = logged.testApp;

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    const { id } = created.json();
    const pid = testApp.app.browserSessions.getPid(id);
    expect(isAlive(pid!)).toBe(true);

    await testApp.cleanup();
    testApp = undefined;

    expect(isAlive(pid!)).toBe(false);
  }, 20_000);

  it("rejects new sessions at the concurrency cap, then accepts again after one is released", async () => {
    const logged = await buildLoggedInApp({ ONYX_MAX_CONCURRENT_SESSIONS: "1" });
    testApp = logged.testApp;

    const first = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id;

    const second = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: "at_capacity" });

    await testApp.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${firstId}`,
      cookies: { onyx_session: logged.cookie },
    });

    const third = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    expect(third.statusCode).toBe(201);
  }, 30_000);

  it("auto-releases a session that sits idle past its idle timeout", async () => {
    const logged = await buildLoggedInApp({
      ONYX_SESSION_IDLE_TIMEOUT_MS: "300",
      ONYX_SESSION_MAX_LIFETIME_MS: "60000",
    });
    testApp = logged.testApp;

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    const { id } = created.json();
    const pid = testApp.app.browserSessions.getPid(id);

    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(testApp.app.browserSessions.isActive(id)).toBe(false);
    expect(isAlive(pid!)).toBe(false);

    const row = testApp.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "browserSession.timeout_idle"), eq(auditLog.target, id)))
      .all();
    expect(row).toHaveLength(1);
  }, 20_000);

  it("auto-releases a session that outlives its absolute lifetime, even if never idle", async () => {
    const logged = await buildLoggedInApp({
      ONYX_SESSION_IDLE_TIMEOUT_MS: "60000",
      ONYX_SESSION_MAX_LIFETIME_MS: "300",
    });
    testApp = logged.testApp;

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    const { id } = created.json();

    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(testApp.app.browserSessions.isActive(id)).toBe(false);

    const row = testApp.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "browserSession.timeout_absolute"), eq(auditLog.target, id)))
      .all();
    expect(row).toHaveLength(1);
  }, 20_000);

  it("only the creator or an admin may release a session", async () => {
    const logged = await buildLoggedInApp();
    testApp = logged.testApp;
    const other = await createTestUser(testApp.db, { email: "other-browser-user@example.com", password: "other-password-1" });
    const otherLogin = await testApp.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: other.email, password: "other-password-1" },
    });
    const otherCookie = getCookie(otherLogin.headers["set-cookie"], "onyx_session");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/sessions",
      cookies: { onyx_session: logged.cookie },
    });
    const { id } = created.json();

    const forbidden = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${id}`,
      cookies: { onyx_session: otherCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const ownRelease = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${id}`,
      cookies: { onyx_session: logged.cookie },
    });
    expect(ownRelease.statusCode).toBe(204);
  }, 20_000);
});

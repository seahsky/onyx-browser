import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp, createTestUser, type TestApp } from "./helpers/app.js";

function getCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  const value = match?.split(";")[0]?.split("=").slice(1).join("=");
  if (!value) throw new Error(`expected a ${name} cookie in the response`);
  return value;
}

async function loginAndGetCookie(testApp: TestApp, email: string, password: string): Promise<string> {
  const login = await testApp.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password },
  });
  return getCookie(login.headers["set-cookie"], "onyx_session");
}

describe("API keys", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("creates a key, returns the full secret once, and never returns it again from GET", async () => {
    testApp = await buildTestApp();
    const user = await createTestUser(testApp.db, { email: "owner@example.com", password: "owner-password-1" });
    const sessionCookie = await loginAndGetCookie(testApp, user.email, "owner-password-1");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/keys",
      cookies: { onyx_session: sessionCookie },
      payload: { label: "CI key", scopes: ["sessions:read", "sessions:write"] },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.key).toMatch(/^onyx_[0-9a-f]{12}_/);
    expect(body).not.toHaveProperty("secretHash");

    const listed = await testApp.app.inject({
      method: "GET",
      url: "/v1/keys",
      cookies: { onyx_session: sessionCookie },
    });
    expect(listed.statusCode).toBe(200);
    const list = listed.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: body.id, keyId: body.keyId, label: "CI key" });
    expect(list[0]).not.toHaveProperty("key");
    expect(list[0]).not.toHaveProperty("secretHash");
  });

  it("authenticates a protected route via Authorization: Bearer with a freshly created key", async () => {
    testApp = await buildTestApp();
    const user = await createTestUser(testApp.db, { email: "bearer@example.com", password: "bearer-password-1" });
    const sessionCookie = await loginAndGetCookie(testApp, user.email, "bearer-password-1");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/keys",
      cookies: { onyx_session: sessionCookie },
      payload: { label: "bearer key", scopes: ["cdp:connect"] },
    });
    const { key, keyId } = created.json();

    const me = await testApp.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ kind: "apiKey", keyId, scopes: ["cdp:connect"] });
  });

  it("rejects a garbage bearer token", async () => {
    testApp = await buildTestApp();
    const response = await testApp.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer onyx_not_a_real_key" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a well-formed key with a wrong secret (no timing shortcut via query-by-secret)", async () => {
    testApp = await buildTestApp();
    const user = await createTestUser(testApp.db, { email: "tamper@example.com", password: "tamper-password-1" });
    const sessionCookie = await loginAndGetCookie(testApp, user.email, "tamper-password-1");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/keys",
      cookies: { onyx_session: sessionCookie },
      payload: { label: "tamper key", scopes: ["cdp:connect"] },
    });
    const { keyId } = created.json();

    const forged = `onyx_${keyId}_${"a".repeat(43)}`;
    const response = await testApp.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("revokes a key, after which it is rejected", async () => {
    testApp = await buildTestApp();
    const user = await createTestUser(testApp.db, { email: "revoke@example.com", password: "revoke-password-1" });
    const sessionCookie = await loginAndGetCookie(testApp, user.email, "revoke-password-1");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/keys",
      cookies: { onyx_session: sessionCookie },
      payload: { label: "to revoke", scopes: ["sessions:read"] },
    });
    const { key, keyId } = created.json();

    const meBefore = await testApp.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(meBefore.statusCode).toBe(200);

    const revoked = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/keys/${keyId}`,
      cookies: { onyx_session: sessionCookie },
    });
    expect(revoked.statusCode).toBe(204);

    const meAfter = await testApp.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it("404s revoking a key that does not belong to the caller", async () => {
    testApp = await buildTestApp();
    const owner = await createTestUser(testApp.db, { email: "keyowner@example.com", password: "owner-password-2" });
    const other = await createTestUser(testApp.db, { email: "other@example.com", password: "other-password-1" });
    const ownerCookie = await loginAndGetCookie(testApp, owner.email, "owner-password-2");
    const otherCookie = await loginAndGetCookie(testApp, other.email, "other-password-1");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/keys",
      cookies: { onyx_session: ownerCookie },
      payload: { label: "owner's key", scopes: ["sessions:read"] },
    });
    const { keyId } = created.json();

    const response = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/keys/${keyId}`,
      cookies: { onyx_session: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("never accepts an API key for key management routes, only a user session", async () => {
    testApp = await buildTestApp();
    const user = await createTestUser(testApp.db, { email: "admin-only@example.com", password: "admin-password-1" });
    const sessionCookie = await loginAndGetCookie(testApp, user.email, "admin-password-1");

    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/keys",
      cookies: { onyx_session: sessionCookie },
      payload: { label: "self key", scopes: ["sessions:read", "sessions:write", "cdp:connect"] },
    });
    const { key } = created.json();

    const response = await testApp.app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

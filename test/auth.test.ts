import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp, createTestUser, type TestApp } from "./helpers/app.js";

function getCookie(setCookieHeader: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  return match?.split(";")[0]?.split("=").slice(1).join("=");
}

describe("auth", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  describe("POST /v1/auth/login", () => {
    it("rejects an unknown email with a generic message", async () => {
      testApp = await buildTestApp();
      const response = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "nobody@example.com", password: "whatever" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });
    });

    it("rejects a wrong password with the same generic message", async () => {
      testApp = await buildTestApp();
      const user = await createTestUser(testApp.db, { email: "alice@example.com", password: "correct-password-1" });

      const response = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: user.email, password: "wrong-password" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });
    });

    it("logs in successfully and issues a signed httpOnly session cookie", async () => {
      testApp = await buildTestApp();
      const user = await createTestUser(testApp.db, { email: "bob@example.com", password: "correct-password-2" });

      const response = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: user.email, password: "correct-password-2" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: user.id, email: user.email, role: "user" });

      const setCookie = response.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      const cookieHeaders = Array.isArray(setCookie) ? setCookie : [setCookie];
      const sessionCookie = cookieHeaders.find((h) => h?.startsWith("onyx_session="));
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);
    });

    it("is case-insensitive on email", async () => {
      testApp = await buildTestApp();
      const user = await createTestUser(testApp.db, { email: "casey@example.com", password: "correct-password-3" });

      const response = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "CASEY@EXAMPLE.COM", password: "correct-password-3" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: user.id });
    });
  });

  describe("session cookie lifecycle", () => {
    it("authenticates GET /v1/auth/me with the issued cookie, and rejects after logout", async () => {
      testApp = await buildTestApp();
      const user = await createTestUser(testApp.db, { email: "dana@example.com", password: "correct-password-4" });

      const login = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: user.email, password: "correct-password-4" },
      });
      const sessionCookie = getCookie(login.headers["set-cookie"], "onyx_session");
      expect(sessionCookie).toBeDefined();

      const me = await testApp.app.inject({
        method: "GET",
        url: "/v1/auth/me",
        cookies: { onyx_session: sessionCookie! },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ kind: "user", id: user.id, email: user.email, role: "user" });

      const logout = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        cookies: { onyx_session: sessionCookie! },
      });
      expect(logout.statusCode).toBe(204);

      const meAfterLogout = await testApp.app.inject({
        method: "GET",
        url: "/v1/auth/me",
        cookies: { onyx_session: sessionCookie! },
      });
      expect(meAfterLogout.statusCode).toBe(401);
    });

    it("rejects a request with no cookie at all", async () => {
      testApp = await buildTestApp();
      const response = await testApp.app.inject({ method: "GET", url: "/v1/auth/me" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a forged/unsigned cookie value", async () => {
      testApp = await buildTestApp();
      const response = await testApp.app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { cookie: "onyx_session=not-a-real-signed-value" },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});

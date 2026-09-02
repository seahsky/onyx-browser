import { desc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { auditLog } from "../src/db/schema.js";
import { buildTestApp, createTestUser, type TestApp } from "./helpers/app.js";

describe("login rate limiting", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("locks out further attempts for one email after repeated failures, independent of the per-IP limit", async () => {
    testApp = await buildTestApp();
    const user = await createTestUser(testApp.db, { email: "locked@example.com", password: "the-real-password-1" });

    for (let i = 0; i < 10; i++) {
      const response = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: user.email, password: "wrong" },
      });
      expect(response.statusCode).toBe(401);
    }

    // The 11th failure is the first one where the per-email lockout is
    // already tripped — still the same generic response...
    const eleventh = await testApp.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: "wrong" },
    });
    expect(eleventh.statusCode).toBe(401);
    expect(eleventh.json()).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });

    // ...even the *correct* password is rejected once locked out.
    const correctButLocked = await testApp.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: user.email, password: "the-real-password-1" },
    });
    expect(correctButLocked.statusCode).toBe(401);

    // ...but internally, the audit log distinguishes why.
    const [lastEntry] = testApp.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, user.email))
      .orderBy(desc(auditLog.id))
      .limit(1)
      .all();
    expect(lastEntry?.detail).toMatchObject({ reason: "rate_limited" });
  });

  it("rate limits POST /v1/auth/login per IP", async () => {
    testApp = await buildTestApp();

    let sawTooManyRequests = false;
    for (let i = 0; i < 25; i++) {
      const response = await testApp.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "irrelevant@example.com", password: "wrong" },
      });
      if (response.statusCode === 429) {
        sawTooManyRequests = true;
        break;
      }
    }
    expect(sawTooManyRequests).toBe(true);
  });
});

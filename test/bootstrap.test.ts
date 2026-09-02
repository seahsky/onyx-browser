import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BootstrapError,
  completeSetup,
  getPendingSetupToken,
  resetBootstrapStateForTests,
  runBootstrap,
} from "../src/auth/bootstrap.js";
import { users } from "../src/db/schema.js";
import { buildTestApp, type TestApp } from "./helpers/app.js";

describe("bootstrap", () => {
  let testApp: TestApp | undefined;

  beforeEach(() => {
    resetBootstrapStateForTests();
  });

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("does nothing when a user already exists", async () => {
    testApp = await buildTestApp();
    testApp.db.insert(users).values({ email: "existing@example.com", passwordHash: "x", role: "user" }).run();

    await runBootstrap(testApp.db, testApp.config, testApp.app.log);

    expect(getPendingSetupToken()).toBeNull();
  });

  it("creates the admin directly from ONYX_ADMIN_EMAIL/ONYX_ADMIN_PASSWORD", async () => {
    testApp = await buildTestApp({
      ONYX_ADMIN_EMAIL: "admin@example.com",
      ONYX_ADMIN_PASSWORD: "a-fine-long-password",
    });

    await runBootstrap(testApp.db, testApp.config, testApp.app.log);

    expect(getPendingSetupToken()).toBeNull();
    const admin = testApp.db.select().from(users).where(eq(users.email, "admin@example.com")).get();
    expect(admin?.role).toBe("admin");
  });

  it("rejects a too-short ONYX_ADMIN_PASSWORD", async () => {
    testApp = await buildTestApp({ ONYX_ADMIN_EMAIL: "admin@example.com", ONYX_ADMIN_PASSWORD: "short1" });
    await expect(runBootstrap(testApp.db, testApp.config, testApp.app.log)).rejects.toThrow(BootstrapError);
  });

  it("rejects a denylisted ONYX_ADMIN_PASSWORD", async () => {
    testApp = await buildTestApp({ ONYX_ADMIN_EMAIL: "admin@example.com", ONYX_ADMIN_PASSWORD: "password123" });
    await expect(runBootstrap(testApp.db, testApp.config, testApp.app.log)).rejects.toThrow(BootstrapError);
  });

  it("generates a one-time setup token when no admin env vars are set", async () => {
    testApp = await buildTestApp();
    await runBootstrap(testApp.db, testApp.config, testApp.app.log);
    expect(getPendingSetupToken()).toBeTruthy();
  });

  describe("POST /setup", () => {
    it("creates the first admin with a valid token, then rejects reuse", async () => {
      testApp = await buildTestApp();
      await runBootstrap(testApp.db, testApp.config, testApp.app.log);
      const token = getPendingSetupToken();
      expect(token).toBeTruthy();

      const response = await testApp.app.inject({
        method: "POST",
        url: "/setup",
        payload: { token, email: "setup-admin@example.com", password: "a-fine-long-password" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ email: "setup-admin@example.com" });

      const admin = testApp.db.select().from(users).where(eq(users.email, "setup-admin@example.com")).get();
      expect(admin?.role).toBe("admin");

      const reuse = await testApp.app.inject({
        method: "POST",
        url: "/setup",
        payload: { token, email: "second-admin@example.com", password: "a-fine-long-password" },
      });
      expect(reuse.statusCode).toBe(400);
    });

    it("rejects an invalid token", async () => {
      testApp = await buildTestApp();
      await runBootstrap(testApp.db, testApp.config, testApp.app.log);

      const response = await testApp.app.inject({
        method: "POST",
        url: "/setup",
        payload: { token: "not-the-real-token", email: "x@example.com", password: "a-fine-long-password" },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("completeSetup", () => {
    it("throws when called with no pending token", async () => {
      testApp = await buildTestApp();
      await expect(
        completeSetup(testApp.db, "anything", "x@example.com", "a-fine-long-password"),
      ).rejects.toThrow(BootstrapError);
    });
  });
});

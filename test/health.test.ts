import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

describe("GET /health", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("returns 200 with a minimal ok body and no credentials required", async () => {
    testApp = await buildTestApp();
    const response = await testApp.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

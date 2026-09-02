import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp, createTestUser, type TestApp } from "./helpers/app.js";

const CHROME_EXECUTABLE_PATH = "/opt/pw-browsers/chromium";

// Drives the actual built UI (ui/dist — see the root "pretest" script) in a
// real browser through the whole M6 flow: log in, create a key, create a
// session, see the viewer render a frame.
describe("web UI (end to end)", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("logs in, creates a key, creates a session, and renders a viewer frame", async () => {
    testApp = await buildTestApp({ ONYX_CHROME_EXECUTABLE_PATH: CHROME_EXECUTABLE_PATH });
    await testApp.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (testApp.app.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const user = await createTestUser(testApp.db, { email: "e2e-user@example.com", password: "e2e-password-123" });

    const driver = await chromium.launch({ executablePath: CHROME_EXECUTABLE_PATH, headless: true });
    try {
      const page = await driver.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.goto(baseUrl);
      await page.waitForSelector("form.login-form", { timeout: 10_000 });

      await page.fill('input[type="email"]', user.email);
      await page.fill('input[type="password"]', "e2e-password-123");
      await page.click('button[type="submit"]');
      await page.waitForSelector(".dashboard-header", { timeout: 10_000 });

      // Create an API key.
      await page.fill('input[placeholder="Label (e.g. CI)"]', "e2e key");
      await page.click("text=Create key");
      await page.waitForSelector(".key-reveal code", { timeout: 5_000 });
      const keyText = await page.textContent(".key-reveal code");
      expect(keyText).toMatch(/^onyx_[0-9a-f]{12}_/);

      // Create a session and watch it come up.
      await page.click("text=New session");
      await page.waitForSelector(".status-running", { timeout: 20_000 });

      // Open the viewer and wait for a real frame.
      await page.click("text=View");
      await page.waitForSelector('[data-testid="viewer-frame"]', { timeout: 20_000 });
      const frameSrc = await page.getAttribute('[data-testid="viewer-frame"]', "src");
      expect(frameSrc).toMatch(/^data:image\/jpeg;base64,/);
      expect(frameSrc?.length ?? 0).toBeGreaterThan("data:image/jpeg;base64,".length);

      expect(pageErrors).toEqual([]);
    } finally {
      await driver.close();
    }
  }, 45_000);
});

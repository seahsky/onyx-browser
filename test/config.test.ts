import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const validSecret = "s".repeat(32);

describe("loadConfig", () => {
  it("throws ConfigError naming ONYX_SESSION_SECRET when missing", () => {
    expect(() => loadConfig({ NODE_ENV: "development" })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: "development" });
      expect.fail("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("ONYX_SESSION_SECRET");
    }
  });

  it("rejects a session secret shorter than 32 bytes", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "development", ONYX_SESSION_SECRET: "short" }),
    ).toThrowError(/ONYX_SESSION_SECRET/);
  });

  it("accepts a 32-byte session secret and applies defaults in development", () => {
    const config = loadConfig({ NODE_ENV: "development", ONYX_SESSION_SECRET: validSecret });

    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.publicOrigin).toBe("http://localhost:3000");
    expect(config.databaseUrl).toBe("file:./data/onyx.db");
    expect(config.maxConcurrentSessions).toBe(5);
    expect(config.sessionIdleTimeoutMs).toBe(300_000);
    expect(config.sessionMaxLifetimeMs).toBe(1_800_000);
    expect(config.allowPrivateNetwork).toBe(false);
  });

  it("requires ONYX_PUBLIC_URL in production and never derives it from HOST", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", ONYX_SESSION_SECRET: validSecret, HOST: "0.0.0.0" }),
    ).toThrowError(/ONYX_PUBLIC_URL/);
  });

  it("derives publicOrigin from ONYX_PUBLIC_URL in production, stripped to origin only", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      ONYX_SESSION_SECRET: validSecret,
      ONYX_PUBLIC_URL: "https://onyx.example.com/some/path?query=1",
    });

    expect(config.publicOrigin).toBe("https://onyx.example.com");
  });

  it("rejects a malformed ONYX_PUBLIC_URL", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ONYX_SESSION_SECRET: validSecret,
        ONYX_PUBLIC_URL: "not-a-url",
      }),
    ).toThrowError(/ONYX_PUBLIC_URL/);
  });

  it("rejects a non-boolean ONYX_ALLOW_PRIVATE_NETWORK", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        ONYX_SESSION_SECRET: validSecret,
        ONYX_ALLOW_PRIVATE_NETWORK: "yes",
      }),
    ).toThrowError(/ONYX_ALLOW_PRIVATE_NETWORK/);
  });

  it("rejects a non-integer ONYX_MAX_CONCURRENT_SESSIONS", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        ONYX_SESSION_SECRET: validSecret,
        ONYX_MAX_CONCURRENT_SESSIONS: "not-a-number",
      }),
    ).toThrowError(/ONYX_MAX_CONCURRENT_SESSIONS/);
  });

  it("reports every invalid variable at once, not just the first", () => {
    try {
      loadConfig({
        NODE_ENV: "production",
        ONYX_SESSION_SECRET: "short",
        ONYX_ALLOW_PRIVATE_NETWORK: "sure",
      });
      expect.fail("expected loadConfig to throw");
    } catch (err) {
      const message = (err as ConfigError).message;
      expect(message).toContain("ONYX_PUBLIC_URL");
      expect(message).toContain("ONYX_SESSION_SECRET");
      expect(message).toContain("ONYX_ALLOW_PRIVATE_NETWORK");
    }
  });
});

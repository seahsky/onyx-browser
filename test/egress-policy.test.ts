import { describe, expect, it } from "vitest";
import { evaluateEgress } from "../src/egress/policy.js";

describe("evaluateEgress", () => {
  it("denies a file:// URL before any resolution happens", async () => {
    const decision = await evaluateEgress("file:///etc/passwd", false);
    expect(decision).toMatchObject({ allowed: false, reason: "denied_scheme" });
  });

  it("denies a literal loopback IP with no DNS lookup needed", async () => {
    const decision = await evaluateEgress("http://127.0.0.1:3000", false);
    expect(decision).toMatchObject({ allowed: false, reason: "denied_address", resolvedAddresses: ["127.0.0.1"] });
  });

  it("denies the literal cloud metadata address", async () => {
    const decision = await evaluateEgress("http://169.254.169.254/latest/meta-data/", false);
    expect(decision).toMatchObject({ allowed: false, reason: "denied_address", resolvedAddresses: ["169.254.169.254"] });
  });

  it("denies a hostname that resolves to a loopback address (localhost)", async () => {
    const decision = await evaluateEgress("http://localhost:3000", false);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("denied_address");
  });

  it("allows a public address by default", async () => {
    const decision = await evaluateEgress("https://1.1.1.1/", false);
    expect(decision).toMatchObject({ allowed: true, resolvedAddresses: ["1.1.1.1"] });
  });

  it("allows about:blank and data: URLs (nothing to resolve)", async () => {
    await expect(evaluateEgress("about:blank", false)).resolves.toMatchObject({ allowed: true });
    await expect(evaluateEgress("data:text/plain,hi", false)).resolves.toMatchObject({ allowed: true });
  });

  it("ONYX_ALLOW_PRIVATE_NETWORK disables only the private-range checks, not the scheme denylist", async () => {
    await expect(evaluateEgress("http://127.0.0.1:3000", true)).resolves.toMatchObject({ allowed: true });
    await expect(evaluateEgress("file:///etc/passwd", true)).resolves.toMatchObject({
      allowed: false,
      reason: "denied_scheme",
    });
  });
});

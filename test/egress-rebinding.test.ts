import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateEgress } from "../src/egress/policy.js";

describe("DNS rebinding protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-resolves on every call instead of caching — a hostname that turns private on a later lookup is caught then, not missed", async () => {
    // dns.promises.lookup is overloaded by its `all` option; evaluateEgress
    // only ever calls the {all: true} form, but vi.spyOn types against the
    // first overload. Mock through that one specific signature instead of
    // fighting TS's overload resolution.
    type AllLookup = (hostname: string, options: unknown) => Promise<{ address: string; family: number }[]>;
    const responses: { address: string; family: number }[][] = [
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }],
    ];
    const lookupSpy = vi.spyOn(dns, "lookup") as unknown as { mockImplementation: (fn: AllLookup) => void } & typeof dns.lookup;
    lookupSpy.mockImplementation(async () => {
      const next = responses.shift();
      if (!next) throw new Error("no more mocked DNS responses queued");
      return next;
    });

    const first = await evaluateEgress("http://attacker.example/", false);
    expect(first).toMatchObject({ allowed: true, resolvedAddresses: ["93.184.216.34"] });

    const second = await evaluateEgress("http://attacker.example/", false);
    expect(second).toMatchObject({ allowed: false, reason: "denied_address", resolvedAddresses: ["127.0.0.1"] });

    // Two independent lookups — nothing short-circuited the second call
    // with a cached result from the first.
    expect(lookupSpy).toHaveBeenCalledTimes(2);
  });
});

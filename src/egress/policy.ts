import dns from "node:dns/promises";
import net from "node:net";
import { isDeniedAddress, isDeniedScheme } from "./rules.js";

export type EgressDenyReason = "denied_scheme" | "unparseable_url" | "denied_address" | "dns_resolution_failed";

export interface EgressDecision {
  allowed: boolean;
  reason?: EgressDenyReason;
  resolvedAddresses?: string[];
}

/**
 * Resolves the request's hostname fresh on every call — never cached — and
 * checks the address that resolution actually returns, not the hostname
 * itself. That's what closes the DNS rebinding gap: a hostname that
 * resolved to a public address a second ago can still resolve to a private
 * one right now, and this re-resolves every time a request is intercepted.
 */
export async function evaluateEgress(rawUrl: string, allowPrivateNetwork: boolean): Promise<EgressDecision> {
  if (isDeniedScheme(rawUrl)) {
    return { allowed: false, reason: "denied_scheme" };
  }

  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return { allowed: false, reason: "unparseable_url" };
  }

  if (!hostname) {
    // data:, about:, blob: — nothing to resolve, no egress involved.
    return { allowed: true };
  }

  if (allowPrivateNetwork) {
    return { allowed: true };
  }

  if (net.isIP(hostname)) {
    if (isDeniedAddress(hostname)) {
      return { allowed: false, reason: "denied_address", resolvedAddresses: [hostname] };
    }
    return { allowed: true, resolvedAddresses: [hostname] };
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { allowed: false, reason: "dns_resolution_failed" };
  }

  const addresses = records.map((record) => record.address);
  if (addresses.length === 0 || addresses.some((address) => isDeniedAddress(address))) {
    return { allowed: false, reason: "denied_address", resolvedAddresses: addresses };
  }
  return { allowed: true, resolvedAddresses: addresses };
}

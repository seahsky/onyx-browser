import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, type TestApp } from "./helpers/app.js";

interface RouteRef {
  method: string;
  url: string;
}

// Every route registered on the app that is NOT listed here must reject a
// credential-less request with 401. Adding a new route means explicitly
// deciding whether it belongs on this list — that decision is the point of
// this test, not an afterthought. See build spec milestone M2.
const PUBLIC_ALLOWLIST: RouteRef[] = [
  { method: "GET", url: "/health" },
  { method: "HEAD", url: "/health" },
  { method: "POST", url: "/v1/auth/login" },
  { method: "POST", url: "/setup" },
];

function isAllowlisted(method: string, url: string): boolean {
  return PUBLIC_ALLOWLIST.some((entry) => entry.method === method && entry.url === url);
}

/** Fastify route params (:id) and wildcards (*) need a real value to be injectable. */
function fillRouteParams(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, "route-param-placeholder").replace(/\*$/, "wildcard-placeholder");
}

interface Violation {
  method: string;
  url: string;
  statusCode: number;
}

/** The actual enumeration + assertion mechanic, shared by both tests below. */
async function findUnauthenticatedAccessViolations(
  app: FastifyInstance,
  allowlist: RouteRef[],
): Promise<Violation[]> {
  const violations: Violation[] = [];

  for (const route of app.routeInventory) {
    if (allowlist.some((entry) => entry.method === route.method && entry.url === route.url)) continue;

    const response = await app.inject({
      method: route.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
      url: fillRouteParams(route.url),
    });

    if (response.statusCode !== 401) {
      violations.push({ method: route.method, url: route.url, statusCode: response.statusCode });
    }
  }

  return violations;
}

describe("every registered route requires credentials unless explicitly allowlisted", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.cleanup();
    testApp = undefined;
  });

  it("rejects every non-allowlisted route with 401 when called with no credentials", async () => {
    testApp = await buildTestApp();
    await testApp.app.ready();

    // Sanity check the test itself isn't vacuous — if route registration
    // ever breaks, this catches it before the (empty) loop below silently
    // passes.
    expect(testApp.app.routeInventory.length).toBeGreaterThan(10);

    const violations = await findUnauthenticatedAccessViolations(testApp.app, PUBLIC_ALLOWLIST);

    expect(violations).toEqual([]);
  });

  it("fails correctly when a route is temporarily unguarded", async () => {
    testApp = await buildTestApp();
    // No preHandler at all — the same mistake this test exists to catch.
    testApp.app.get("/__temporarily_unguarded_for_test__", async () => ({ ok: true }));
    await testApp.app.ready();

    const violations = await findUnauthenticatedAccessViolations(testApp.app, PUBLIC_ALLOWLIST);

    expect(violations).toContainEqual({
      method: "GET",
      url: "/__temporarily_unguarded_for_test__",
      statusCode: 200,
    });
  });
});

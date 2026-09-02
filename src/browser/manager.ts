import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { chromium, type BrowserServer } from "playwright-core";
import { recordAudit } from "../auth/audit.js";
import type { Principal } from "../auth/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { browserSessions } from "../db/schema.js";
import { attachEgressGuard, type EgressGuardHandle } from "./egress-guard.js";
import { getFreePort } from "./port.js";

export class ConcurrencyLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`at the concurrent session limit (${limit})`);
  }
}

export interface CreateSessionResult {
  id: string;
  cdpPort: number;
  expiresAt: Date;
}

type ReleaseReason = "released" | "timeout_idle" | "timeout_absolute" | "crashed";

interface ActiveSession {
  id: string;
  server: BrowserServer;
  cdpPort: number;
  idleTimeoutMs: number;
  idleTimer: NodeJS.Timeout;
  absoluteTimer: NodeJS.Timeout;
  egressGuard: EgressGuardHandle;
}

// Any row still marked non-terminal at boot belonged to a process that no
// longer exists — browser child processes don't survive a restart of this
// one. Mark them crashed so the audit trail reflects reality instead of
// claiming a session is still running forever.
export function reconcileStaleSessionsOnBoot(db: Db): void {
  db.update(browserSessions)
    .set({ status: "crashed", releasedAt: new Date() })
    .where(inArray(browserSessions.status, ["starting", "running", "releasing"]))
    .run();
}

function principalRef(principal: Principal): { kind: "user" | "apiKey"; id: string } {
  return principal.kind === "user"
    ? { kind: "user", id: principal.userId }
    : { kind: "apiKey", id: principal.keyId };
}

// One Chrome process per session (not one browser with a context per
// session): with multi-user auth in scope, process isolation between users
// matters more than the extra memory it costs, and the concurrency cap is
// what keeps that memory bounded. See build spec open question #1.
export class BrowserSessionManager {
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger,
  ) {}

  activeCount(): number {
    return this.active.size;
  }

  hasCapacity(): boolean {
    return this.active.size < this.config.maxConcurrentSessions;
  }

  async create(principal: Principal): Promise<CreateSessionResult> {
    if (!this.hasCapacity()) {
      throw new ConcurrencyLimitError(this.config.maxConcurrentSessions);
    }

    const id = randomUUID();
    const cdpPort = await getFreePort();
    const server = await this.launchChromium(cdpPort);

    // Egress protection is not optional: a session with no guard attached
    // is a session that can reach the private network, so a failure here
    // must fail session creation too, not launch unprotected.
    let egressGuard: EgressGuardHandle;
    try {
      egressGuard = await attachEgressGuard(cdpPort, id, this.db, this.config.allowPrivateNetwork, this.logger);
    } catch (err) {
      await server.close().catch(() => {});
      throw err;
    }

    const now = Date.now();
    const idleTimeoutMs = this.config.sessionIdleTimeoutMs;
    const maxLifetimeMs = this.config.sessionMaxLifetimeMs;
    const ref = principalRef(principal);

    this.db
      .insert(browserSessions)
      .values({
        id,
        status: "running",
        createdByKind: ref.kind,
        createdById: ref.id,
        idleTimeoutMs,
        maxLifetimeMs,
      })
      .run();

    const absoluteTimer = setTimeout(() => {
      void this.autoRelease(id, "timeout_absolute");
    }, maxLifetimeMs).unref();

    const idleTimer = setTimeout(() => {
      void this.autoRelease(id, "timeout_idle");
    }, idleTimeoutMs).unref();

    const session: ActiveSession = { id, server, cdpPort, idleTimeoutMs, idleTimer, absoluteTimer, egressGuard };
    this.active.set(id, session);

    server.on("close", () => {
      if (this.active.has(id)) {
        void this.autoRelease(id, "crashed");
      }
    });

    recordAudit(this.db, {
      principalKind: ref.kind,
      principalId: ref.id,
      action: "browserSession.create",
      target: id,
    });

    return { id, cdpPort, expiresAt: new Date(now + maxLifetimeMs) };
  }

  /** Resets the idle deadline. Called by the CDP proxy (M4) on real traffic. */
  touch(sessionId: string): void {
    const session = this.active.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.autoRelease(sessionId, "timeout_idle");
    }, session.idleTimeoutMs).unref();
  }

  getCdpPort(sessionId: string): number | null {
    return this.active.get(sessionId)?.cdpPort ?? null;
  }

  getPid(sessionId: string): number | null {
    return this.active.get(sessionId)?.server.process().pid ?? null;
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Explicit release requested by a caller — records who asked for it. */
  async release(sessionId: string, principal: Principal): Promise<boolean> {
    const ref = principalRef(principal);
    return this.doRelease(sessionId, "released", ref);
  }

  private async autoRelease(sessionId: string, reason: Exclude<ReleaseReason, "released">): Promise<void> {
    await this.doRelease(sessionId, reason, null);
    if (reason !== "crashed") {
      this.logger.info({ sessionId, reason }, "browser session auto-released");
    } else {
      this.logger.warn({ sessionId }, "browser process exited unexpectedly");
    }
  }

  private async doRelease(
    sessionId: string,
    reason: ReleaseReason,
    ref: { kind: "user" | "apiKey"; id: string } | null,
  ): Promise<boolean> {
    const session = this.active.get(sessionId);
    if (!session) return false;

    this.active.delete(sessionId);
    clearTimeout(session.idleTimer);
    clearTimeout(session.absoluteTimer);
    session.egressGuard.close();

    if (reason !== "crashed") {
      try {
        await session.server.close();
      } catch (err) {
        this.logger.warn({ err, sessionId }, "error closing browser during release");
      }
    }

    this.db
      .update(browserSessions)
      .set({ status: reason === "crashed" ? "crashed" : "released", releasedAt: new Date() })
      .where(eq(browserSessions.id, sessionId))
      .run();

    recordAudit(this.db, {
      principalKind: ref?.kind ?? "anonymous",
      principalId: ref?.id ?? null,
      action: `browserSession.${reason}`,
      target: sessionId,
    });

    return true;
  }

  /** Closes every active browser. Wired to the Fastify onClose hook and signal handlers. */
  async closeAll(): Promise<void> {
    const ids = [...this.active.keys()];
    await Promise.all(
      ids.map(async (id) => {
        const session = this.active.get(id);
        if (!session) return;
        this.active.delete(id);
        clearTimeout(session.idleTimer);
        clearTimeout(session.absoluteTimer);
        session.egressGuard.close();
        try {
          await session.server.close();
        } catch (err) {
          this.logger.warn({ err, sessionId: id }, "error closing browser during shutdown");
        }
        this.db
          .update(browserSessions)
          .set({ status: "released", releasedAt: new Date() })
          .where(eq(browserSessions.id, id))
          .run();
      }),
    );
  }

  private async launchChromium(cdpPort: number): Promise<BrowserServer> {
    const baseArgs = [
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-dev-shm-usage",
    ];
    // Omit the key entirely rather than passing executablePath: undefined —
    // exactOptionalPropertyTypes treats those differently, and playwright-core's
    // own default-resolution logic only kicks in when the key is absent.
    const executablePathOpt = this.config.chromeExecutablePath
      ? { executablePath: this.config.chromeExecutablePath }
      : {};

    try {
      return await chromium.launchServer({ ...executablePathOpt, headless: true, args: baseArgs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const looksLikeSandboxFailure = ["sandbox", "namespace"].some((hint) =>
        message.toLowerCase().includes(hint),
      );
      if (!looksLikeSandboxFailure) throw err;

      this.logger.warn(
        { err },
        "Chrome's sandbox failed to initialize (container has no usable user namespaces) — retrying with --no-sandbox",
      );
      return await chromium.launchServer({
        ...executablePathOpt,
        headless: true,
        args: [...baseArgs, "--no-sandbox"],
      });
    }
  }
}

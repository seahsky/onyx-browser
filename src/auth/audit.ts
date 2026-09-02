import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { auditLog } from "../db/schema.js";

export interface AuditEventInput {
  principalKind: "user" | "apiKey" | "anonymous";
  principalId?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

/** audit_log is append-only from application code — no update/delete helpers exist on purpose. */
export function recordAudit(db: Db, event: AuditEventInput): void {
  db.insert(auditLog)
    .values({
      principalKind: event.principalKind,
      principalId: event.principalId ?? null,
      action: event.action,
      target: event.target ?? null,
      ip: event.ip ?? null,
      detail: event.detail ?? null,
    })
    .run();
}

/** Backs the per-email login lockout — no separate counter table needed. */
export function countRecentLoginFailures(db: Db, email: string, windowMs: number): number {
  return db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "auth.login.failure"),
        eq(auditLog.target, email),
        gte(auditLog.at, new Date(Date.now() - windowMs)),
      ),
    )
    .all().length;
}

// 审计日志（F-COMP-03）
import type { Db } from './db.ts'
import { sqlNow } from './util.ts'

export function audit(db: Db, username: string | null, action: string, object: string | null = null, objectId: number | null = null, detail: unknown = null): void {
  db.prepare(
    `INSERT INTO audit_log (username, action, object, object_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(username ?? 'system', action, object, objectId, detail ? JSON.stringify(detail) : null, sqlNow())
}

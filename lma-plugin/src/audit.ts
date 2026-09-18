// 审计日志（F-COMP-03）
import type { Db } from './db.ts'
import { sqlNow } from './util.ts'

/** 审计上下文：来源 IP / User-Agent / 会话标识 / 结果。403 拒绝也必须留痕。 */
export interface AuditContext {
  ip?: string | null
  ua?: string | null
  sessionId?: string | null
  result?: 'ok' | 'denied'
}

export function audit(
  db: Db,
  username: string | null,
  action: string,
  object: string | null = null,
  objectId: number | null = null,
  detail: unknown = null,
  ctx: AuditContext = {},
): void {
  db.prepare(
    `INSERT INTO audit_log (username, action, object, object_id, detail, created_at, ip, ua, session_id, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    username ?? 'system', action, object, objectId,
    detail ? JSON.stringify(detail) : null, sqlNow(),
    ctx.ip ?? null, (ctx.ua ?? '').slice(0, 300) || null, ctx.sessionId ?? null, ctx.result ?? 'ok',
  )
}

/** 取真实客户端 IP：只信任反代追加的**最右**一跳（最左可被伪造） */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const xff = headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff.join(',') : (xff ?? '')
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : fallback
}

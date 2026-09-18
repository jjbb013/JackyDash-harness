// 服务端会话（F-AUTH-03）：会话表 + HttpOnly Cookie。零依赖，不需要 Redis。
//
// 设计要点：
// - **Cookie 里只放随机 token**，不放用户名/角色；每次请求用 token 回查会话表并 JOIN lma_user，
//   这样"禁用账号 / 改密码 / 改角色"能**立即生效**（无状态 JWT 做不到，仍需黑名单表）。
// - **表里存 token 的 sha256，不存原文**：万一数据库被读走，也无法直接拿去冒充登录。
// - 登录成功必须**轮换 session ID**（新建行 + 删旧行），防会话固定攻击。
import crypto from 'node:crypto'
import type { Db } from '../db.ts'
import { sqlNow } from '../util.ts'
import { cookieSecure } from '../env.ts'
import type { Role } from '../roles.ts'

export const SESSION_TTL_DAYS = 7
const LAST_SEEN_THROTTLE_MS = 60_000 // last_seen 最多每分钟写一次，避免每个请求都写库

/** 生产用 __Host- 前缀（隐含 Secure + Path=/ + 无 Domain）；本地 http 下浏览器不接受该前缀 */
export function sessionCookieName(): string {
  return cookieSecure() ? '__Host-lma_sid' : 'lma_sid'
}

const tokenHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex')

export interface SessionUser {
  userId: number
  username: string
  role: Role
  mustChangePassword: boolean
  sessionId: string
  expiresAt: string
}

export interface CreatedSession {
  token: string
  expiresAt: string
}

/** 新建会话；调用方负责把 token 写进 Cookie */
export function createSession(db: Db, userId: number, ip?: string | null, ua?: string | null, ttlDays = SESSION_TTL_DAYS): CreatedSession {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  db.prepare(
    `INSERT INTO lma_session (token_hash, user_id, created_at, expires_at, last_seen, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tokenHash(token), userId, sqlNow(), expiresAt, sqlNow(), ip ?? null, (ua ?? '').slice(0, 300) || null)
  return { token, expiresAt }
}

/**
 * 校验会话并返回当前用户（含**实时的** role/status）。
 * 返回 null 的情况：token 不存在 / 已过期 / 用户被禁用。
 */
export function readSession(db: Db, token: string): SessionUser | null {
  if (!token) return null
  const row = db.prepare(
    `SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen,
            u.username, u.role, u.status, u.must_change_password
       FROM lma_session s JOIN lma_user u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(tokenHash(token)) as
    | { token_hash: string; user_id: number; expires_at: string; last_seen: string; username: string; role: Role; status: string; must_change_password: number }
    | undefined
  if (!row) return null

  // 过期即删（顺带清理），并对禁用账号立即失效
  if (row.expires_at <= sqlNow() || row.status !== 'active') {
    db.prepare('DELETE FROM lma_session WHERE token_hash = ?').run(row.token_hash)
    return null
  }

  const lastSeenMs = Date.parse(String(row.last_seen).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs > LAST_SEEN_THROTTLE_MS) {
    db.prepare('UPDATE lma_session SET last_seen = ? WHERE token_hash = ?').run(sqlNow(), row.token_hash)
  }

  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    sessionId: row.token_hash.slice(0, 12), // 只用于审计标识，不回传原文
    expiresAt: row.expires_at,
  }
}

export function destroySession(db: Db, token: string): void {
  if (!token) return
  db.prepare('DELETE FROM lma_session WHERE token_hash = ?').run(tokenHash(token))
}

/** 踢掉某用户的全部会话（禁用 / 改密 / 改角色时调用） */
export function destroyUserSessions(db: Db, userId: number): number {
  const r = db.prepare('DELETE FROM lma_session WHERE user_id = ?').run(userId)
  return Number(r.changes ?? 0)
}

/** 清掉过期会话（定时任务调用） */
export function purgeExpiredSessions(db: Db): number {
  const r = db.prepare('DELETE FROM lma_session WHERE expires_at <= ?').run(sqlNow())
  return Number(r.changes ?? 0)
}

// ---------- Cookie 工具（原生 node:http 没有 cookie 解析） ----------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function buildSessionCookie(token: string, maxAgeSec = SESSION_TTL_DAYS * 86_400): string {
  const attrs = [`${sessionCookieName()}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`]
  if (cookieSecure()) attrs.push('Secure')
  return attrs.join('; ')
}

export function buildClearCookie(): string {
  const attrs = [`${sessionCookieName()}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (cookieSecure()) attrs.push('Secure')
  return attrs.join('; ')
}

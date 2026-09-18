// 登录限流（F-AUTH-05）：单进程 + SQLite，无需 Redis。
//
// 规则（按 **username + IP 组合**计，不按 username 单独计——否则攻击者可以用同事的用户名
// 反复失败，把同事的账号恶意锁死，形成 DoS）：
//   连续失败 ≥ 5  → 指数退避：第 n 次失败后需等待 min(2^(n-5), 30) 秒
//   15 分钟内失败 ≥ 10 → 锁定该组合 15 分钟
// 失败与锁定都写审计（由调用方负责）。
import type { Db } from '../db.ts'
import { sqlNow } from '../util.ts'

export const WINDOW_SEC = 15 * 60
export const LOCK_SEC = 15 * 60
const SOFT_FAILS = 5
const HARD_FAILS = 10
const MAX_DELAY_SEC = 30

export const throttleKey = (username: string, ip: string): string => `${username.trim().toLowerCase()}|${ip}`

export interface ThrottleState {
  allowed: boolean
  /** 还需等待多少秒才能再试（allowed=false 时有效） */
  retryAfterSec: number
  /** 窗口内失败次数 */
  fails: number
  /** 是否已被硬锁 */
  locked: boolean
}

const mem = new Map<string, { fails: number; lastAt: number }>()

const toMs = (sqliteUtc: string): number => Date.parse(String(sqliteUtc).replace(' ', 'T') + 'Z')

/** 查当前是否可尝试登录 */
export function checkThrottle(db: Db, username: string, ip: string, now = Date.now()): ThrottleState {
  const key = throttleKey(username, ip)
  const since = new Date(now - WINDOW_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')

  const row = db.prepare(
    `SELECT COUNT(*) AS fails, MAX(at) AS lastAt FROM login_attempt
      WHERE username = ? AND ip = ? AND ok = 0 AND at >= ?`,
  ).get(username.trim(), ip, since) as { fails: number; lastAt: string | null } | undefined

  const fails = Number(row?.fails ?? 0)
  const lastAtMs = row?.lastAt ? toMs(row.lastAt) : (mem.get(key)?.lastAt ?? 0)

  if (fails >= HARD_FAILS) {
    const until = lastAtMs + LOCK_SEC * 1000
    const retry = Math.ceil((until - now) / 1000)
    if (retry > 0) return { allowed: false, retryAfterSec: retry, fails, locked: true }
  }
  if (fails >= SOFT_FAILS) {
    const delay = Math.min(2 ** (fails - SOFT_FAILS), MAX_DELAY_SEC)
    const waitMs = lastAtMs + delay * 1000 - now
    if (waitMs > 0) return { allowed: false, retryAfterSec: Math.ceil(waitMs / 1000), fails, locked: false }
  }
  return { allowed: true, retryAfterSec: 0, fails, locked: false }
}

export function recordAttempt(db: Db, username: string, ip: string, ok: boolean, now = Date.now()): void {
  const at = new Date(now).toISOString().slice(0, 19).replace('T', ' ')
  db.prepare('INSERT INTO login_attempt (username, ip, at, ok) VALUES (?, ?, ?, ?)')
    .run(username.trim(), ip, at, ok ? 1 : 0)
  const key = throttleKey(username, ip)
  if (ok) {
    // 成功即清零：删除该组合的历史失败记录。否则"试错若干次后成功登录"仍会被旧计数继续退避/锁定。
    db.prepare('DELETE FROM login_attempt WHERE username = ? AND ip = ? AND ok = 0').run(username.trim(), ip)
    mem.delete(key)
  } else {
    mem.set(key, { fails: (mem.get(key)?.fails ?? 0) + 1, lastAt: now })
  }
}

/** 清理窗口外历史（定时任务调用） */
export function purgeOldAttempts(db: Db, now = Date.now()): number {
  const before = new Date(now - WINDOW_SEC * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const r = db.prepare('DELETE FROM login_attempt WHERE at < ?').run(before)
  return Number(r.changes ?? 0)
}

export const throttleNow = sqlNow // 便于测试注入保持一致的时间格式

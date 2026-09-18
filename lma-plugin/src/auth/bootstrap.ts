// 首个管理员引导（F-AUTH-06）
//
// 为什么需要：加了登录墙之后，如果库里一个用户都没有，就会**没人能登进去**（自己把自己锁死）。
// 规则：
//   1. 库里已有任何用户 → 什么都不做（绝不重置、绝不覆盖已有管理员密码）
//   2. 库为空 → 用 LMA_ADMIN_USER（默认 admin）建一个 admin：
//        · 设了 LMA_ADMIN_PASSWORD → 用它，且不强制改密（适合部署脚本一次性注入）
//        · 没设 → 生成一次性随机密码，强制首登改密，由调用方**只打印一次**
// 这条路径是"启动兜底"，不是日常建号通道；日常建号走仪表盘「人员管理」（S5）。
import crypto from 'node:crypto'
import type { Db } from '../db.ts'
import { hashPasswordSync, generateTempPassword } from './passwords.ts'
import { audit } from '../audit.ts'
import { agentIdentity, roleOfUser, type Role } from '../roles.ts'

export interface BootstrapResult {
  created: boolean
  username?: string
  /** 仅当自动生成时返回；调用方只应打印一次，不要写进日志文件之外的持久存储 */
  generatedPassword?: string
  mustChange: boolean
}

export function ensureBootstrapAdmin(db: Db): BootstrapResult {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM lma_user').get() as { c: number }
  if (c > 0) return { created: false, mustChange: false }

  const username = (process.env.LMA_ADMIN_USER ?? 'admin').trim() || 'admin'
  const explicit = (process.env.LMA_ADMIN_PASSWORD ?? '').trim()
  const generated = explicit ? '' : generateTempPassword(16)
  const password = explicit || generated

  db.prepare(
    `INSERT INTO lma_user (username, password_hash, role, status, must_change_password)
     VALUES (?, ?, 'admin', 'active', ?)`,
  ).run(username, hashPasswordSync(password), explicit ? 0 : 1)

  audit(db, username, 'auth.bootstrap_admin', 'lma_user', null, { generated: !explicit })
  return { created: true, username, generatedPassword: generated || undefined, mustChange: !explicit }
}

/**
 * 登记 Agent 的**服务账号**（F-AUTH-07）。
 * 工具层以这个身份执行，角色取自 lma_user —— 所以"聊天里能做什么"由管理员在人员管理里改这个账号的角色即可。
 * 密码是随机值且永不打印，因此它无法用于网页登录，只是权限载体。
 */
export function ensureAgentAccount(db: Db): { created: boolean; username: string; role: Role | null } {
  const username = agentIdentity()
  const existed = db.prepare('SELECT id FROM lma_user WHERE username = ?').get(username)
  if (existed) return { created: false, username, role: roleOfUser(db, username) }

  const role: Role = (process.env.LMA_AGENT_ROLE ?? 'admin').trim() === 'staff' ? 'staff' : 'admin'
  const unusable = crypto.randomBytes(32).toString('base64url')
  db.prepare(
    `INSERT INTO lma_user (username, password_hash, role, status, must_change_password)
     VALUES (?, ?, ?, 'active', 0)`,
  ).run(username, hashPasswordSync(unusable), role)
  audit(db, username, 'auth.bootstrap_agent', 'lma_user', null, { role })
  return { created: true, username, role }
}

// 人员管理（F-AUTH-08）：账号由 admin 创建，系统**不提供自助注册**
//
//   GET  /api/users          账号列表（不含任何密码字段）
//   POST /api/users          新建账号 → 返回**一次性临时密码**（仅此一次响应，不写日志、不入库明文）
//   POST /api/users/update   set_role / set_status / reset_password
//
// 关键护栏（防止把自己锁死）：
//   · 不允许把**最后一个可用管理员**降级或禁用
//   · 禁用 / 改角色 / 重置密码都会**立即销毁该账号的全部会话**
//   · 不做物理删除（审计按 username 关联，删了会断链），只做禁用
import type { Db } from '../db.ts'
import { hashPassword, generateTempPassword } from '../auth/passwords.ts'
import { destroyUserSessions, type SessionUser } from '../auth/session.ts'
import { audit, type AuditContext } from '../audit.ts'

export interface AdminResponse { status: number; body: unknown }

type Role = 'admin' | 'staff'
const ROLES: Role[] = ['admin', 'staff']
const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/

/** 统计"除某人之外"还有几个可用管理员 */
function otherActiveAdmins(db: Db, exceptId: number): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM lma_user WHERE role = 'admin' AND status = 'active' AND id != ?`,
  ).get(exceptId) as { c: number }
  return Number(row.c)
}

export function listUsers(db: Db): AdminResponse {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.role, u.status, u.must_change_password, u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM lma_session s WHERE s.user_id = u.id) AS sessions
       FROM lma_user u ORDER BY u.id`,
  ).all()
  return { status: 200, body: { rows } }
}

export async function createUser(
  db: Db, actor: SessionUser, body: Record<string, unknown>, ctx: AuditContext,
): Promise<AdminResponse> {
  const username = String(body.username ?? '').trim()
  const role = String(body.role ?? 'staff') as Role
  if (!USERNAME_RE.test(username)) return { status: 400, body: { error: '用户名需为 2~32 位的字母、数字或 . _ -' } }
  if (!ROLES.includes(role)) return { status: 400, body: { error: 'role 必须是 admin 或 staff' } }
  if (db.prepare('SELECT id FROM lma_user WHERE username = ?').get(username)) {
    return { status: 409, body: { error: '用户名已存在' } }
  }

  const tempPassword = generateTempPassword(16)
  const r = db.prepare(
    `INSERT INTO lma_user (username, password_hash, role, status, must_change_password)
     VALUES (?, ?, ?, 'active', 1)`,
  ).run(username, await hashPassword(tempPassword), role)
  audit(db, actor.username, 'user.create', 'lma_user', Number(r.lastInsertRowid), { username, role }, { ...ctx, sessionId: actor.sessionId })

  // 一次性临时密码：只在这条响应里出现一次
  return { status: 200, body: { ok: true, id: Number(r.lastInsertRowid), username, role, tempPassword } }
}

export async function updateUser(
  db: Db, actor: SessionUser, body: Record<string, unknown>, ctx: AuditContext,
): Promise<AdminResponse> {
  const id = Number(body.id)
  const action = String(body.action ?? '')
  if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { error: '缺少 id' } }

  const target = db.prepare('SELECT id, username, role, status FROM lma_user WHERE id = ?')
    .get(id) as { id: number; username: string; role: Role; status: string } | undefined
  if (!target) return { status: 404, body: { error: '账号不存在' } }

  const auditCtx: AuditContext = { ...ctx, sessionId: actor.sessionId }
  const lastAdminGuard = (): AdminResponse | null =>
    target.role === 'admin' && target.status === 'active' && otherActiveAdmins(db, target.id) === 0
      ? { status: 409, body: { error: '系统必须保留至少一个可用管理员，无法对最后一个管理员执行该操作' } }
      : null

  if (action === 'set_role') {
    const role = String(body.role ?? '') as Role
    if (!ROLES.includes(role)) return { status: 400, body: { error: 'role 必须是 admin 或 staff' } }
    if (role === target.role) return { status: 200, body: { ok: true, unchanged: true } }
    if (role === 'staff') {
      const blocked = lastAdminGuard()
      if (blocked) return blocked
    }
    db.prepare("UPDATE lma_user SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, id)
    destroyUserSessions(db, id) // 权限变化立即生效：踢掉其全部会话
    audit(db, actor.username, 'user.set_role', 'lma_user', id, { username: target.username, from: target.role, to: role }, auditCtx)
    return { status: 200, body: { ok: true, role } }
  }

  if (action === 'set_status') {
    const status = String(body.status ?? '')
    if (status !== 'active' && status !== 'disabled') return { status: 400, body: { error: 'status 必须是 active 或 disabled' } }
    if (status === target.status) return { status: 200, body: { ok: true, unchanged: true } }
    if (status === 'disabled') {
      const blocked = lastAdminGuard()
      if (blocked) return blocked
    }
    db.prepare("UPDATE lma_user SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
    const killed = status === 'disabled' ? destroyUserSessions(db, id) : 0
    audit(db, actor.username, 'user.set_status', 'lma_user', id, { username: target.username, status, killedSessions: killed }, auditCtx)
    return { status: 200, body: { ok: true, status } }
  }

  if (action === 'reset_password') {
    const tempPassword = generateTempPassword(16)
    db.prepare(
      `UPDATE lma_user SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(await hashPassword(tempPassword), id)
    destroyUserSessions(db, id)
    audit(db, actor.username, 'user.reset_password', 'lma_user', id, { username: target.username }, auditCtx)
    return { status: 200, body: { ok: true, username: target.username, tempPassword } }
  }

  return { status: 400, body: { error: '未知操作，action 必须是 set_role / set_status / reset_password' } }
}

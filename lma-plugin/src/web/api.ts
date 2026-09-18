// LMA 仪表盘 JSON API：供插件自带 Web 页面（/）调用
// 写操作按 PRD 角色表校验 X-LMA-Operator（审核：admin/staff；手动退订：仅 admin），
// 统一走 roles.ts 的角色判定；只读操作当前无需身份（本服务默认只绑 127.0.0.1，
// 部署到 VPS 前必须补上真正的登录鉴权，见 README「部署」章节）。
import type { Db } from '../db.ts'
import { getProfile, getEmailTemplate, getSendPolicy } from '../db.ts'
import { queueSnapshot, todaySentCount } from '../sendqueue.ts'
import { audit } from '../audit.ts'
import { isValidEmail, sqlNow } from '../util.ts'
import { requireRole } from '../roles.ts'

export interface ApiResponse { status: number; body: unknown }

const num = (v: string | null, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

function overview(db: Db): ApiResponse {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  const sent = one(`SELECT COUNT(*) AS c FROM email_event WHERE event_type = 'sent'`)
  const replied = one(`SELECT COUNT(*) AS c FROM email_event WHERE event_type = 'replied'`)
  return {
    status: 200,
    body: {
      supplierTotal: one(`SELECT COUNT(*) AS c FROM supplier WHERE deleted_at IS NULL`),
      sent, replied,
      replyRate: sent ? Math.round((replied / sent) * 1000) / 10 : 0,
      todaySent: todaySentCount(db),
      queuePending: queueSnapshot().length,
      byStatus: db.prepare(`SELECT status, COUNT(*) AS c FROM supplier WHERE deleted_at IS NULL GROUP BY status`).all(),
      byCountry: db.prepare(`SELECT country, COUNT(*) AS c FROM supplier WHERE deleted_at IS NULL AND country IS NOT NULL GROUP BY country ORDER BY c DESC LIMIT 20`).all(),
      pendingReview: one(`SELECT COUNT(*) AS c FROM email_draft WHERE status = 'draft'`),
    },
  }
}

function suppliers(db: Db, p: URLSearchParams): ApiResponse {
  const where = ['deleted_at IS NULL']
  const a: unknown[] = []
  const country = p.get('country')?.trim()
  const status = p.get('status')?.trim()
  const kw = p.get('q')?.trim()
  if (country) { where.push('country = ?'); a.push(country) }
  if (status) { where.push('status = ?'); a.push(status) }
  if (kw) { where.push('(company_name LIKE ? OR email LIKE ? OR contact_name LIKE ? OR business LIKE ?)'); const l = `%${kw}%`; a.push(l, l, l, l) }
  const w = where.join(' AND ')
  const page = Math.max(1, num(p.get('page'), 1))
  const size = Math.min(100, num(p.get('size'), 20))
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM supplier WHERE ${w}`).get(...a) as { c: number }).c
  const rows = db.prepare(
    `SELECT id, company_name, contact_name, email, country, timezone, status, match_score, source, last_contact_at, created_at
     FROM supplier WHERE ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...a, size, (page - 1) * size)
  return { status: 200, body: { total, page, size, rows } }
}

function supplierDetail(db: Db, p: URLSearchParams): ApiResponse {
  const id = num(p.get('id'), 0)
  const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!s) return { status: 404, body: { error: '供应商不存在' } }
  const events = db.prepare(
    `SELECT e.*, d.subject AS draft_subject FROM email_event e LEFT JOIN email_draft d ON d.id = e.draft_id
     WHERE e.supplier_id = ? ORDER BY e.event_time DESC, e.id DESC LIMIT 30`,
  ).all(id)
  const drafts = db.prepare(
    'SELECT id, subject, status, language, match_score, created_at, reviewed_at, reject_reason FROM email_draft WHERE supplier_id = ? ORDER BY id DESC LIMIT 10',
  ).all(id)
  return { status: 200, body: { supplier: s, events, drafts } }
}

function reviewQueue(db: Db, p: URLSearchParams): ApiResponse {
  const status = p.get('status') ?? 'draft'
  const page = Math.max(1, num(p.get('page'), 1))
  const size = Math.min(100, num(p.get('size'), 20))
  const total = (db.prepare('SELECT COUNT(*) AS c FROM email_draft WHERE status = ?').get(status) as { c: number }).c
  const rows = db.prepare(
    `SELECT d.id, d.supplier_id, d.subject, d.body, d.language, d.match_score, d.match_analysis, d.created_at,
            s.company_name, s.email, s.country
     FROM email_draft d JOIN supplier s ON s.id = d.supplier_id
     WHERE d.status = ? AND s.deleted_at IS NULL ORDER BY d.id DESC LIMIT ? OFFSET ?`,
  ).all(status, size, (page - 1) * size)
  return { status: 200, body: { total, page, size, rows } }
}

function review(db: Db, operator: string, body: Record<string, unknown>): ApiResponse {
  // PRD 角色表：staff 也可以审核邮件
  const perm = requireRole(operator, ['admin', 'staff'])
  if (!perm.ok) return { status: 403, body: { error: perm.error } }
  const id = num(String(body.draft_id ?? ''), 0)
  const action = String(body.action ?? '')
  const draft = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(id) as { status: string; supplier_id: number } | undefined
  if (!draft) return { status: 404, body: { error: '草稿不存在' } }
  if (draft.status !== 'draft') return { status: 409, body: { error: '只有 draft 状态的草稿可审核' } }
  if (action === 'reject') {
    const reason = String(body.reason ?? '').trim()
    if (!reason) return { status: 400, body: { error: '驳回必须填写原因' } }
    db.prepare(`UPDATE email_draft SET status = 'rejected', reject_reason = ?, reviewer = ?, reviewed_at = datetime('now') WHERE id = ?`).run(reason, operator, id)
    db.prepare(`UPDATE supplier SET status = 'matched', updated_at = datetime('now') WHERE id = ?`).run(draft.supplier_id)
    audit(db, operator, 'review_reject', 'email_draft', id, { reason, via: 'web' })
    return { status: 200, body: { ok: true, status: 'rejected' } }
  }
  if (action === 'approve') {
    db.prepare(`UPDATE email_draft SET status = 'approved', reviewer = ?, reviewed_at = datetime('now') WHERE id = ?`).run(operator, id)
    db.prepare(`UPDATE supplier SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(draft.supplier_id)
    audit(db, operator, 'review_approve', 'email_draft', id, { supplierId: draft.supplier_id, via: 'web' })
    return { status: 200, body: { ok: true, status: 'approved' } }
  }
  return { status: 400, body: { error: 'action 必须是 approve 或 reject' } }
}

function sendQueue(db: Db): ApiResponse {
  return {
    status: 200,
    body: {
      pending: queueSnapshot().map((q) => ({ ...q, dueAtIso: q.dueAt ? new Date(q.dueAt).toISOString() : null })),
      todaySent: todaySentCount(db),
      policy: getSendPolicy(db),
    },
  }
}

function unsubscribes(db: Db): ApiResponse {
  const rows = db.prepare('SELECT id, email, source, unsubscribed_at, handled_by, note FROM unsubscribe_list ORDER BY id DESC LIMIT 500').all()
  return { status: 200, body: { rows } }
}

function unsubscribeAdd(db: Db, operator: string, body: Record<string, unknown>): ApiResponse {
  // 退订名单维护为合规动作，PRD 角色表未授予 staff，仅 admin
  const perm = requireRole(operator, ['admin'])
  if (!perm.ok) return { status: 403, body: { error: perm.error } }
  const email = String(body.email ?? '').toLowerCase().trim()
  if (!isValidEmail(email)) return { status: 400, body: { error: '邮箱格式错误' } }
  db.prepare('INSERT OR IGNORE INTO unsubscribe_list (email, source, unsubscribed_at, handled_by, note) VALUES (?, ?, ?, ?, ?)')
    .run(email, 'manual', sqlNow(), operator, String(body.note ?? '').trim() || null)
  db.prepare(`UPDATE supplier SET status = 'unsubscribed', updated_at = datetime('now') WHERE email = ? AND deleted_at IS NULL`).run(email)
  audit(db, operator, 'unsubscribe_manual', 'unsubscribe_list', null, { email, via: 'web' })
  return { status: 200, body: { ok: true } }
}

function config(db: Db): ApiResponse {
  return { status: 200, body: { profile: getProfile(db), email_template: getEmailTemplate(db), send_policy: getSendPolicy(db) } }
}

/**
 * 路由一条 /api/* 请求；不属于 API 的路径返回 null（由调用方继续处理）。
 */
export function handleApi(db: Db, method: string, pathname: string, params: URLSearchParams, operator: string, body: Record<string, unknown>): ApiResponse | null {
  switch (pathname) {
    case '/api/overview': return method === 'GET' ? overview(db) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/suppliers': return method === 'GET' ? suppliers(db, params) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/supplier': return method === 'GET' ? supplierDetail(db, params) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/review-queue': return method === 'GET' ? reviewQueue(db, params) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/review': return method === 'POST' ? review(db, operator, body) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/send-queue': return method === 'GET' ? sendQueue(db) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/unsubscribes': return method === 'GET' ? unsubscribes(db) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/unsubscribe': return method === 'POST' ? unsubscribeAdd(db, operator, body) : { status: 405, body: { error: 'Method Not Allowed' } }
    case '/api/config': return method === 'GET' ? config(db) : { status: 405, body: { error: 'Method Not Allowed' } }
    default: return null
  }
}

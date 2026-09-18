// LMA 仪表盘 JSON API：供插件自带 Web 页面（/）调用
// 身份来自**会话**（server.ts 解析 Cookie → readSession），不再信任任何客户端传入的操作者字段。
// 每个路由在 ROUTE_ROLES 里显式登记「允许的方法 + 允许的角色」，**未登记即 404、角色不符即 403**
// （白名单而非黑名单：新增端点忘了登记权限时会直接拒绝，不会默认放行）。
import type { Db } from '../db.ts'
import { getProfile, getEmailTemplate, getSendPolicy, getAiConfig, setConfig } from '../db.ts'
import { queueSnapshot, todaySentCount } from '../sendqueue.ts'
import { audit } from '../audit.ts'
import { isValidEmail, sqlNow, maskSecret } from '../util.ts'
import type { SessionUser } from '../auth/session.ts'
import { listUsers, createUser, updateUser } from './admin.ts'
import { requestSend } from '../sendqueue.ts'
import { exportSuppliersCsv } from '../exporter.ts'
import { checkFollowups } from '../followup.ts'
import { previewImport, confirmImport, auditImport } from '../importing.ts'

export interface ApiResponse {
  status: number
  body: unknown
  /** 设置后按原样发送（如 text/csv 导出），否则按 JSON 序列化 */
  contentType?: string
  headers?: Record<string, string>
}

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

function review(db: Db, user: SessionUser, body: Record<string, unknown>): ApiResponse {
  const operator = user.username // 角色判定已由 ROUTE_ROLES 完成
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

function unsubscribeAdd(db: Db, user: SessionUser, body: Record<string, unknown>): ApiResponse {
  const operator = user.username // 角色判定已由 ROUTE_ROLES 完成
  const email = String(body.email ?? '').toLowerCase().trim()
  if (!isValidEmail(email)) return { status: 400, body: { error: '邮箱格式错误' } }
  db.prepare('INSERT OR IGNORE INTO unsubscribe_list (email, source, unsubscribed_at, handled_by, note) VALUES (?, ?, ?, ?, ?)')
    .run(email, 'manual', sqlNow(), operator, String(body.note ?? '').trim() || null)
  db.prepare(`UPDATE supplier SET status = 'unsubscribed', updated_at = datetime('now') WHERE email = ? AND deleted_at IS NULL`).run(email)
  audit(db, operator, 'unsubscribe_manual', 'unsubscribe_list', null, { email, via: 'web' })
  return { status: 200, body: { ok: true } }
}

/** POST /api/send：把已批准草稿入队（守卫与 lma_send 共用 requestSend） */
function send(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): ApiResponse {
  const draftId = num(String(body.draft_id ?? ''), 0)
  const r = requestSend(db, draftId)
  audit(db, user.username, r.ok ? 'send_request' : 'send_denied', 'email_draft', draftId || null, {
    queued: r.queued, dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null, reason: r.reason, error: r.error, via: 'web',
  }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId, result: r.ok ? 'ok' : 'denied' })
  if (!r.ok) return { status: 409, body: { error: r.error } }
  return {
    status: 200,
    body: { ok: true, queued: r.queued, dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null, reason: r.reason ?? null },
  }
}

/** POST /api/followup：按规则扫描并生成跟进草稿（默认只进审核队列） */
async function followup(db: Db, user: SessionUser, ctx: ApiContext): Promise<ApiResponse> {
  const result = await checkFollowups(db, user.username)
  audit(db, user.username, 'followup_check', 'supplier', null, { ...result, via: 'web' }, {
    ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId,
  })
  return { status: 200, body: result }
}

/** GET /api/export：按筛选导出 CSV（浏览器直接下载） */
function exportCsv(db: Db, user: SessionUser, params: URLSearchParams, ctx: ApiContext): ApiResponse {
  const filters = {
    country: params.get('country')?.trim() || undefined,
    status: params.get('status')?.trim() || undefined,
    q: params.get('q')?.trim() || undefined,
  }
  const r = exportSuppliersCsv(db, filters, user.username)
  audit(db, user.username, 'export', 'supplier', null, { rows: r.rows, filters, via: 'web' }, {
    ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId,
  })
  const stamp = new Date().toISOString().slice(0, 10)
  return {
    status: 200,
    body: r.csv,
    contentType: 'text/csv; charset=utf-8',
    headers: { 'Content-Disposition': `attachment; filename="lma-suppliers-${stamp}.csv"` },
  }
}

/** POST /api/import/preview：解析 + 字段映射 + 校验统计（与 lma_import_preview 共用实现） */
async function importPreview(db: Db, body: Record<string, unknown>): Promise<ApiResponse> {
  try {
    const r = await previewImport(db, {
      content: body.content ? String(body.content) : undefined,
      defaultCountry: body.default_country ? String(body.default_country) : undefined,
    })
    return { status: 200, body: r }
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } }
  }
}

/** POST /api/import/confirm：按策略落库（与 lma_import_confirm 共用实现） */
function importConfirm(db: Db, user: SessionUser, body: Record<string, unknown>): ApiResponse {
  const strategy = String(body.dedupe_strategy ?? 'skip')
  if (!['skip', 'update', 'create'].includes(strategy)) {
    return { status: 400, body: { error: 'dedupe_strategy 必须是 skip / update / create' } }
  }
  try {
    const report = confirmImport(db, String(body.batch_id ?? ''), {
      strategy: strategy as 'skip' | 'update' | 'create',
      sourceNote: String(body.source_note ?? ''),
      defaultCountry: body.default_country ? String(body.default_country) : undefined,
      defaultLanguage: body.default_language ? String(body.default_language) : undefined,
    }, user.username)
    auditImport(db, user.username, report)
    return { status: 200, body: { report } }
  } catch (e) {
    return { status: 400, body: { error: (e as Error).message } }
  }
}

/** GET /api/ai-config：**绝不回传 Key 明文**，只回是否已设置与掩码 */
function aiConfigView(db: Db): ApiResponse {
  const c = getAiConfig(db)
  return {
    status: 200,
    body: {
      mode: c.mode,
      url: c.url,
      model: c.model,
      keySet: Boolean(c.key),
      keyMasked: c.key ? maskSecret(c.key) : '',
      envFallback: Boolean(process.env.LMA_AI_URL || process.env.LMA_AI_KEY),
    },
  }
}

/** POST /api/ai-config：保存端点/Key/模型。key 不传或留空=保持不变，传 __clear__=清除 */
function saveAiConfig(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): ApiResponse {
  const cur = getAiConfig(db)
  const mode = String(body.mode ?? cur.mode)
  if (mode !== 'mock' && mode !== 'api') return { status: 400, body: { error: 'mode 必须是 mock 或 api' } }

  const keyInput = body.key === undefined ? undefined : String(body.key)
  let key = cur.key
  if (keyInput === '__clear__') key = ''
  else if (keyInput && keyInput.trim()) key = keyInput.trim()

  const next = {
    mode: mode as 'mock' | 'api',
    url: String(body.url ?? cur.url).trim().replace(/\/+$/, ''),
    model: String(body.model ?? cur.model).trim() || 'deepseek-chat',
    key,
  }
  if (next.mode === 'api' && (!next.url || !next.key)) {
    return { status: 400, body: { error: 'api 模式必须同时配置端点地址与 API Key；若只想清除 Key，请先把模式改为 mock' } }
  }

  setConfig(db, 'ai_config', next, user.username)
  audit(db, user.username, 'ai_config_update', 'app_config', null, {
    mode: next.mode, url: next.url, model: next.model, keyChanged: key !== cur.key,
  }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId })

  return {
    status: 200,
    body: { ok: true, mode: next.mode, url: next.url, model: next.model, keySet: Boolean(next.key), keyMasked: next.key ? maskSecret(next.key) : '' },
  }
}

function config(db: Db): ApiResponse {
  return { status: 200, body: { profile: getProfile(db), email_template: getEmailTemplate(db), send_policy: getSendPolicy(db) } }
}

/**
 * 路由一条 /api/* 请求；不属于 API 的路径返回 null（由调用方继续处理）。
 */
export interface ApiContext { ip: string; ua: string }

/**
 * 路由 × 角色 白名单。**新增 /api 端点必须在这里登记**，否则一律 404；
 * 登记了但角色不符 → 403 并写审计（拒绝也要留痕）。
 * 后续阶段会加入：/api/send、/api/export、/api/followup、/api/import、/api/users、/api/ai-config。
 */
const ROUTE_ROLES: Record<string, { methods: string[]; roles: Array<'admin' | 'staff'> }> = {
  '/api/overview':     { methods: ['GET'],  roles: ['admin', 'staff'] },
  '/api/suppliers':    { methods: ['GET'],  roles: ['admin', 'staff'] },
  '/api/supplier':     { methods: ['GET'],  roles: ['admin', 'staff'] },
  '/api/review-queue': { methods: ['GET'],  roles: ['admin', 'staff'] },
  '/api/send-queue':   { methods: ['GET'],  roles: ['admin', 'staff'] },
  '/api/unsubscribes': { methods: ['GET'],  roles: ['admin', 'staff'] },
  '/api/config':       { methods: ['GET'],  roles: ['admin'] },        // 配置/画像：仅 admin
  // 写操作
  '/api/review':       { methods: ['POST'], roles: ['admin', 'staff'] }, // 审核邮件：两角色
  '/api/unsubscribe':  { methods: ['POST'], roles: ['admin', 'staff'] }, // 退订名单维护：按决策放开给 staff
  // 业务动作（PRD 角色表：staff 同样可用）
  '/api/send':         { methods: ['POST'], roles: ['admin', 'staff'] }, // 发送（入队）
  '/api/followup':     { methods: ['POST'], roles: ['admin', 'staff'] }, // 标记/执行跟进
  '/api/export':       { methods: ['GET'],  roles: ['admin', 'staff'] }, // 导出名单
  // CSV 导入与 AI 配置：均为 admin 专属
  '/api/import/preview': { methods: ['POST'], roles: ['admin'] },
  '/api/import/confirm': { methods: ['POST'], roles: ['admin'] },
  '/api/ai-config':      { methods: ['GET', 'POST'], roles: ['admin'] },
  // 人员管理（F-AUTH-08）：仅 admin
  '/api/users':        { methods: ['GET', 'POST'], roles: ['admin'] },
  '/api/users/update': { methods: ['POST'],       roles: ['admin'] },
}

/** 路由一条 /api/* 请求。未登记路径返回 404；角色不符返回 403（并写审计）。 */
export async function handleApi(
  db: Db, method: string, pathname: string, params: URLSearchParams,
  user: SessionUser, body: Record<string, unknown>, ctx: ApiContext,
): Promise<ApiResponse> {
  const route = ROUTE_ROLES[pathname]
  if (!route) return { status: 404, body: { error: '接口不存在' } }
  if (!route.methods.includes(method)) return { status: 405, body: { error: 'Method Not Allowed' } }
  if (!route.roles.includes(user.role)) {
    audit(db, user.username, 'api.denied', 'api', null, { pathname, method, role: user.role }, {
      ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId, result: 'denied',
    })
    return { status: 403, body: { error: `当前角色（${user.role}）无权访问 ${pathname}` } }
  }

  switch (pathname) {
    case '/api/overview':     return overview(db)
    case '/api/suppliers':    return suppliers(db, params)
    case '/api/supplier':     return supplierDetail(db, params)
    case '/api/review-queue': return reviewQueue(db, params)
    case '/api/send-queue':   return sendQueue(db)
    case '/api/unsubscribes': return unsubscribes(db)
    case '/api/config':       return config(db)
    case '/api/review':       return review(db, user, body)
    case '/api/unsubscribe':  return unsubscribeAdd(db, user, body)
    case '/api/send':         return send(db, user, body, ctx)
    case '/api/followup':     return await followup(db, user, ctx)
    case '/api/export':       return exportCsv(db, user, params, ctx)
    case '/api/import/preview': return await importPreview(db, body)
    case '/api/import/confirm': return importConfirm(db, user, body)
    case '/api/ai-config':      return method === 'GET' ? aiConfigView(db) : saveAiConfig(db, user, body, ctx)
    case '/api/users':        return method === 'GET' ? listUsers(db) : await createUser(db, user, body, ctx)
    case '/api/users/update': return await updateUser(db, user, body, ctx)
  }
  return { status: 404, body: { error: '接口不存在' } }
}

// LMA 仪表盘 JSON API：供插件自带 Web 页面（/）调用
// 身份来自**会话**（server.ts 解析 Cookie → readSession），不再信任任何客户端传入的操作者字段。
// 每个路由在 ROUTE_ROLES 里显式登记「允许的方法 + 允许的角色」，**未登记即 404、角色不符即 403**
// （白名单而非黑名单：新增端点忘了登记权限时会直接拒绝，不会默认放行）。
import type { Db } from '../db.ts'
import { getProfile, getEmailTemplate, getSendPolicy, getAiConfig, getSmtpConfig, getImapConfig, setConfig } from '../db.ts'
import { countryToTimezone } from '../timezone.ts'
import { queueSnapshot, todaySentCount } from '../sendqueue.ts'
import { audit } from '../audit.ts'
import { getBackupConfig, saveBackupConfig, runBackupAndSend, backupSummary } from '../backup.ts'
import { isValidEmail, sqlNow, maskSecret } from '../util.ts'
import type { SessionUser } from '../auth/session.ts'
import { listUsers, createUser, updateUser } from './admin.ts'
import { requestSend } from '../sendqueue.ts'
import { exportSuppliersCsv } from '../exporter.ts'
import { checkFollowups } from '../followup.ts'
import { previewImport, confirmImport, auditImport } from '../importing.ts'
import { runAssistant } from '../assistant.ts'
import { matchSupplier, generateDraft } from '../ai.ts'

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

/** GET/POST /api/backup-config：读取/保存定时备份配置（仅 admin；to 必填校验） */
function backupConfigView(db: Db): ApiResponse {
  return { status: 200, body: { config: getBackupConfig(db) } }
}
function saveBackupConfigCtl(db: Db, user: SessionUser, body: Record<string, unknown>): ApiResponse {
  const cur = getBackupConfig(db)
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : cur.enabled
  const schedule = ['daily', 'weekly', 'monthly'].includes(String(body.schedule ?? cur.schedule)) ? String(body.schedule ?? cur.schedule) : cur.schedule
  const hour = Number.isInteger(body.hour) ? body.hour : cur.hour
  const minute = Number.isInteger(body.minute) ? body.minute : cur.minute
  const to = String(body.to ?? cur.to).trim()
  const from = body.from !== undefined ? String(body.from).trim() : (cur.from ?? '')
  const includeAudit = body.include_audit !== undefined ? Boolean(body.include_audit) : cur.includeAudit
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { status: 400, body: { error: '时间必须在 00:00–23:59 之间' } }
  if (enabled && !to) return { status: 400, body: { error: '启用定时备份必须填写收件邮箱' } }
  if (enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { status: 400, body: { error: '收件邮箱格式不正确' } }
  const next = { ...cur, enabled, schedule: schedule as 'daily' | 'weekly' | 'monthly', hour, minute, to, from, includeAudit }
  saveBackupConfig(db, next, user.username)
  audit(db, user.username, 'backup_config', 'backup_config', null, { enabled, schedule, hour, minute, to, includeAudit }, { ip: '', ua: '', sessionId: '' })
  return { status: 200, body: { ok: true, config: next } }
}
/** POST /api/backup/send-now：立即生成并发送一次全量备份邮件（仅 admin） */
async function backupSendNow(db: Db, user: SessionUser): Promise<ApiResponse> {
  try {
    const r = await runBackupAndSend(db, user.username)
    return { status: 200, body: { ok: true, ...r } }
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
      thinking: c.thinking,
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

  const thinking = String(body.thinking ?? cur.thinking)
  if (!['auto', 'enabled', 'disabled'].includes(thinking)) return { status: 400, body: { error: 'thinking 必须是 auto / enabled / disabled' } }

  const next = {
    mode: mode as 'mock' | 'api',
    url: String(body.url ?? cur.url).trim().replace(/\/+$/, ''),
    model: String(body.model ?? cur.model).trim() || 'deepseek-chat',
    thinking: thinking as 'auto' | 'enabled' | 'disabled',
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
    body: { ok: true, mode: next.mode, url: next.url, model: next.model, thinking: next.thinking, keySet: Boolean(next.key), keyMasked: next.key ? maskSecret(next.key) : '' },
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
  '/api/backup-config':  { methods: ['GET', 'POST'], roles: ['admin'] },
  '/api/backup/send-now':{ methods: ['POST'],          roles: ['admin'] },
  // 人员管理（F-AUTH-08）：仅 admin
  '/api/users':        { methods: ['GET', 'POST'], roles: ['admin'] },
  '/api/users/update': { methods: ['POST'],       roles: ['admin'] },
  // AI 助手：两角色可用（工具层权限仍按服务身份校验）
  '/api/assistant':    { methods: ['POST'], roles: ['admin', 'staff'] },
  // 邮件收发配置（SMTP/IMAP）：仅 admin（存 app_config，env 兜底）
  '/api/smtp-config':  { methods: ['GET', 'POST'], roles: ['admin'] },
  '/api/imap-config':  { methods: ['GET', 'POST'], roles: ['admin'] },
  // 供应商数据管理（F-DATA-08/09）：编辑/删除/批量编辑 → 仅 admin（PRD 角色表）
  '/api/draft/generate':   { methods: ['POST'], roles: ['admin'] },
  '/api/supplier/update':   { methods: ['POST'], roles: ['admin'] },
  '/api/suppliers/batch-update': { methods: ['POST'], roles: ['admin'] },
  '/api/supplier/delete':   { methods: ['POST'], roles: ['admin'] },
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
    case '/api/assistant': {
      const message = String(body.message ?? '').trim()
      if (!message) return { status: 400, body: { error: 'message 不能为空' } }
      try {
        const result = await runAssistant(db, message)
        audit(db, user.username, 'assistant.run', 'assistant', null, { message: message.slice(0, 200), steps: result.steps.length }, {
          ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId, result: 'ok',
        })
        return { status: 200, body: result }
      } catch (e) {
        audit(db, user.username, 'assistant.run', 'assistant', null, { error: (e as Error).message }, {
          ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId, result: 'error',
        })
        return { status: 502, body: { error: `AI 助手调用失败：${(e as Error).message}` } }
      }
    }

    case '/api/smtp-config': return method === 'GET' ? smtpConfigView(db) : saveSmtpConfig(db, user, body, ctx)
    case '/api/backup-config': return method === 'GET' ? backupConfigView(db) : saveBackupConfigCtl(db, user, body)
    case '/api/backup/send-now': return backupSendNow(db, user)
    case '/api/imap-config': return method === 'GET' ? imapConfigView(db) : saveImapConfig(db, user, body, ctx)
    case '/api/draft/generate':     return await draftGenerate(db, user, body, ctx)
    case '/api/supplier/update':     return supplierUpdate(db, user, body, ctx)
    case '/api/suppliers/batch-update': return supplierBatchUpdate(db, user, body, ctx)
    case '/api/supplier/delete':     return supplierDelete(db, user, body, ctx)
  }
  return { status: 404, body: { error: '接口不存在' } }
}


// ---------- SMTP / IMAP 配置 ----------
/** GET /api/smtp-config：不回传密码明文 */
function smtpConfigView(db: Db): ApiResponse {
  const c = getSmtpConfig(db)
  return {
    status: 200,
    body: {
      host: c.host, port: c.port, secure: c.secure, user: c.user, from: c.from,
      passSet: Boolean(c.pass),
      passMasked: c.pass ? maskSecret(c.pass) : '',
      envFallback: Boolean(process.env.LMA_SMTP_HOST || process.env.LMA_SMTP_USER),
    },
  }
}

/** POST /api/smtp-config：保存；pass 不传或留空=保持不变，传 __clear__=清除 */
function saveSmtpConfig(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): ApiResponse {
  const cur = getSmtpConfig(db)
  const host = String(body.host ?? cur.host).trim()
  const port = Number(body.port ?? cur.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { status: 400, body: { error: '端口不合法' } }
  const user2 = String(body.user ?? cur.user).trim()
  if (host && !user2) return { status: 400, body: { error: '填写了服务器地址就必须填写用户名' } }

  const passInput = body.pass === undefined ? undefined : String(body.pass)
  let pass = cur.pass
  if (passInput === '__clear__') pass = ''
  else if (passInput && passInput.trim()) pass = passInput.trim()

  const next = {
    host,
    port,
    secure: body.secure === undefined ? cur.secure : Boolean(body.secure),
    user: user2,
    pass,
    from: String(body.from ?? cur.from).trim(),
  }
  setConfig(db, 'smtp_config', next, user.username)
  audit(db, user.username, 'smtp_config_update', 'app_config', null, {
    host: next.host, port: next.port, user: next.user, passChanged: pass !== cur.pass,
  }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId })
  return { status: 200, body: { ok: true, host: next.host, port: next.port, secure: next.secure, user: next.user, from: next.from, passSet: Boolean(next.pass) } }
}

/** GET /api/imap-config：不回传密码明文 */
function imapConfigView(db: Db): ApiResponse {
  const c = getImapConfig(db)
  return {
    status: 200,
    body: {
      enabled: c.enabled, host: c.host, port: c.port, tls: c.tls, user: c.user,
      passSet: Boolean(c.pass),
      passMasked: c.pass ? maskSecret(c.pass) : '',
      envFallback: Boolean(process.env.LMA_IMAP_HOST || process.env.LMA_IMAP_USER),
    },
  }
}

/** POST /api/imap-config：保存；pass 不传或留空=保持不变，传 __clear__=清除 */
function saveImapConfig(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): ApiResponse {
  const cur = getImapConfig(db)
  const host = String(body.host ?? cur.host).trim()
  const port = Number(body.port ?? cur.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { status: 400, body: { error: '端口不合法' } }
  const user2 = String(body.user ?? cur.user).trim()
  const enabled = body.enabled === undefined ? cur.enabled : Boolean(body.enabled)
  if (enabled && (!host || !user2)) return { status: 400, body: { error: '启用 IMAP 轮询必须填写服务器地址与用户名' } }

  const passInput = body.pass === undefined ? undefined : String(body.pass)
  let pass = cur.pass
  if (passInput === '__clear__') pass = ''
  else if (passInput && passInput.trim()) pass = passInput.trim()

  const next = { enabled, host, port, tls: body.tls === undefined ? cur.tls : Boolean(body.tls), user: user2, pass }
  setConfig(db, 'imap_config', next, user.username)
  audit(db, user.username, 'imap_config_update', 'app_config', null, {
    enabled: next.enabled, host: next.host, port: next.port, user: next.user, passChanged: pass !== cur.pass,
  }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId })
  return { status: 200, body: { ok: true, enabled: next.enabled, host: next.host, port: next.port, tls: next.tls, user: next.user, passSet: Boolean(next.pass) } }
}

// ---------- 供应商编辑 / 删除（F-DATA-08/09，软删除） ----------
/** 单条编辑可写字段；返回实际变更集 */
const SUPPLIER_EDITABLE = ['company_name', 'contact_name', 'email', 'phone', 'website', 'business', 'country', 'region', 'preferred_language', 'source'] as const

function supplierUpdate(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): ApiResponse {
  const id = Number(body.id)
  if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { error: '缺少有效的供应商 id' } }
  const row = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined
  if (!row) return { status: 404, body: { error: '供应商不存在或已删除' } }

  const sets: string[] = []
  const args: unknown[] = []
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const f of SUPPLIER_EDITABLE) {
    if (body[f] === undefined) continue
    let v = String(body[f]).trim()
    if (f === 'email') {
      if (!isValidEmail(v)) return { status: 400, body: { error: `邮箱不合法：${v}` } }
      v = v.toLowerCase()
    }
    if (v === String(row[f] ?? '')) continue
    sets.push(`${f} = ?`); args.push(v)
    changes[f] = { from: row[f] ?? '', to: v }
  }
  if (!sets.length) return { status: 200, body: { ok: true, changed: 0, message: '没有字段发生变化' } }

  // 改国家 → 重新推断时区（与导入管道一致）
  if (changes.country) {
    const tz = countryToTimezone(changes.country.to)
    if (tz) { sets.push('timezone = ?'); args.push(tz.timezone) }
  }
  // 改邮箱 → 查重（邮箱 + 公司名模糊匹配，与导入去重一致）
  if (changes.email) {
    const dup = db.prepare('SELECT id, company_name FROM supplier WHERE email = ? AND deleted_at IS NULL AND id != ?').get(changes.email.to, id)
    if (dup) return { status: 409, body: { error: `邮箱 ${changes.email.to} 已被其他供应商（${(dup as { company_name: string }).company_name}）使用` } }
  }

  sets.push("updated_at = datetime('now')")
  args.push(id)
  db.prepare(`UPDATE supplier SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  audit(db, user.username, 'supplier.update', 'supplier', id, { changes }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId })
  return { status: 200, body: { ok: true, changed: Object.keys(changes).length, changes } }
}

/** 批量编辑公共字段：country / preferred_language / status / source / region */
function supplierBatchUpdate(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): ApiResponse {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  if (!ids.length || ids.length > 500) return { status: 400, body: { error: 'ids 必须是非空数组（≤500）' } }
  const field = String(body.field ?? '')
  const value = String(body.value ?? '').trim()
  if (!['country', 'preferred_language', 'status', 'source', 'region'].includes(field)) {
    return { status: 400, body: { error: '批量编辑仅支持字段：country / preferred_language / status / source / region' } }
  }
  if (field === 'status' && !['new','matched','drafted','approved','sent','replied','follow_up','unsubscribed','invalid'].includes(value)) {
    return { status: 400, body: { error: '状态不合法' } }
  }
  const placeholders = ids.map(() => '?').join(',')
  const target = db.prepare(`SELECT COUNT(*) AS c FROM supplier WHERE id IN (${placeholders}) AND deleted_at IS NULL`).get(...ids) as { c: number }
  if (target.c === 0) return { status: 404, body: { error: '没有找到可更新的供应商' } }

  const sets = [`${field} = ?`, "updated_at = datetime('now')"]
  const args: unknown[] = [value, ...ids]
  if (field === 'country') {
    const tz = countryToTimezone(value)
    if (tz) { sets.push('timezone = ?'); args.splice(1, 0, tz.timezone) }
  }
  db.prepare(`UPDATE supplier SET ${sets.join(', ')} WHERE id IN (${placeholders}) AND deleted_at IS NULL`).run(...args)
  audit(db, user.username, 'supplier.batch_update', 'supplier', null, { ids, field, value, count: target.c }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId })
  return { status: 200, body: { ok: true, updated: target.c, field, value } }
}

/** 软删除（F-DATA-09）：deleted_at = now；草稿与事件保留（审计留痕） */
function supplierDelete(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): ApiResponse {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  if (!ids.length || ids.length > 500) return { status: 400, body: { error: 'ids 必须是非空数组（≤500）' } }
  const placeholders = ids.map(() => '?').join(',')
  const info = db.prepare(`UPDATE supplier SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id IN (${placeholders}) AND deleted_at IS NULL`).run(...ids)
  audit(db, user.username, 'supplier.delete', 'supplier', null, { ids, deleted: info.changes }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId })
  return { status: 200, body: { ok: true, deleted: info.changes } }
}


// ---------- 一键生成邮件草稿（F-AI-03；mock / api 均可） ----------
const LMA_BASE_URL = (process.env.LMA_BASE_URL ?? process.env.LMA_PUBLIC_URL ?? 'http://127.0.0.1:3081').replace(/\/+$/, '')

async function draftGenerate(db: Db, user: SessionUser, body: Record<string, unknown>, ctx: ApiContext): Promise<ApiResponse> {
  const id = Number(body.supplier_id)
  if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { error: '缺少有效的 supplier_id' } }
  const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined
  if (!s) return { status: 404, body: { error: '供应商不存在或已删除' } }

  let match = { score: Number(s.match_score ?? 0), analysis: String(s.match_analysis ?? '') }
  if (!match.analysis) match = await matchSupplier(db, s as never)

  const draft = await generateDraft(db, s as never, match, LMA_BASE_URL)
  const info = db.prepare(
    `INSERT INTO email_draft (supplier_id, subject, body, language, match_analysis, match_score, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, datetime('now'), datetime('now'))`,
  ).run(id, draft.subject, draft.body, String(s.preferred_language ?? 'en'), match.analysis, match.score, user.username)
  db.prepare(`UPDATE supplier SET status = 'drafted', match_score = ?, match_analysis = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(match.score, match.analysis, id)
  audit(db, user.username, 'create_draft', 'email_draft', Number(info.lastInsertRowid), { supplierId: id }, { ip: ctx.ip, ua: ctx.ua, sessionId: user.sessionId })
  return { status: 200, body: { draft_id: Number(info.lastInsertRowid), subject: draft.subject, body: draft.body, footer_hint: '发送时自动追加来源声明与退订链接' } }
}

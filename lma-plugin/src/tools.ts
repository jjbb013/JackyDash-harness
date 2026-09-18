// LMA 工具集：注册到 ctx.tools，由 Harness Agent 驱动完成全部业务操作
// 设计要点：结构化返回（output.schema 对象/字符串）+ render 给模型可读文本；
// 写操作（导入/审核/发送/退订/配置）按 PRD 角色模型区分 admin / staff。
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Db } from './db.ts'
import { getProfile, getEmailTemplate, getSendPolicy } from './db.ts'
import { previewImport, confirmImport, auditImport } from './importing.ts'
import { matchSupplier, generateDraft } from './ai.ts'
import { exportSuppliersCsv } from './exporter.ts'
import { requestSend, queueSnapshot, todaySentCount } from './sendqueue.ts'
import { checkFollowups } from './followup.ts'
import { applyResult } from './imap.ts'
import { audit } from './audit.ts'
import { isValidEmail, splitMulti, sqlNow } from './util.ts'
import { localTimeString, countryToTimezone } from './timezone.ts'
import { PROJECT_KNOWLEDGE } from './knowledge.ts'
import { requireRoleOf, agentIdentity } from './roles.ts'

const BASE_URL = (process.env.LMA_BASE_URL ?? 'http://127.0.0.1:3081').replace(/\/+$/, '')

// ---------- 角色与权限（PRD「三、用户角色」）----------
// 身份**固定为服务身份**（roles.ts 的 agentIdentity），角色实时取自 lma_user 表。
// 工具的 schema 里不再有 operator 字段 —— 模型无法通过参数改变身份（F-AUTH-07）。
function op(_args?: Record<string, unknown>): string { return agentIdentity() }

/** 仅 admin：导入 / 配置 / 账号与画像维护 / 供应商增删改 */
function requireAdmin(db: Db) { return requireRoleOf(db, op(), ['admin']) }
/** admin 或 staff：审核 / 发送 / 跟进 / 导出等业务操作 */
function requireUser(db: Db) { return requireRoleOf(db, op(), ['admin', 'staff']) }

// ---------- 轻量文本工具包装 ----------
interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, { type: 'string' | 'number' | 'boolean'; required?: boolean; description: string; enum?: string[] }>
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

function textTool(spec: ToolSpec): ToolDefinition {
  // 经 defineTool 构造：获得 schema 参数校验 + 输出 schema 校验（官方推荐路径）
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters as never,
    output: {
      schema: { type: 'string' } as never,
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      try {
        const out = await spec.execute(args as Record<string, unknown>)
        return (typeof out === 'string' ? out : JSON.stringify(out, null, 2)) as never
      } catch (e) {
        throw new Error(`[${spec.name}] ${(e as Error).message}`)
      }
    },
  }) as ToolDefinition
}

const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
// 允许 0（用于关闭节流等场景）
const num0 = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d }

// ================= 工具定义 =================
export function buildLmaTools(db: Db): ToolDefinition[] {
  return [
    // ---------- 总览 ----------
    textTool({
      name: 'lma_dashboard',
      description: '获取物流推广系统总览：供应商总数/今日新增/按国家分布/发送量/回复率',
      parameters: {},
      execute() {
        const q = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as { c: number }
        const sent = q(`SELECT COUNT(*) AS c FROM email_event WHERE event_type='sent'`).c
        const replied = q(`SELECT COUNT(*) AS c FROM email_event WHERE event_type='replied'`).c
        const byCountry = db.prepare(
          `SELECT country, COUNT(*) AS c FROM supplier WHERE deleted_at IS NULL AND country IS NOT NULL GROUP BY country ORDER BY c DESC LIMIT 20`,
        ).all() as Array<{ country: string; c: number }>
        const byStatus = db.prepare(
          `SELECT status, COUNT(*) AS c FROM supplier WHERE deleted_at IS NULL GROUP BY status`,
        ).all() as Array<{ status: string; c: number }>
        return {
          supplierTotal: q(`SELECT COUNT(*) AS c FROM supplier WHERE deleted_at IS NULL`).c,
          sent, replied, replyRate: sent ? Math.round((replied / sent) * 1000) / 10 : 0,
          byCountry, byStatus,
        }
      },
    }),

    // ---------- CSV 导入（预览 / 确认 两步） ----------
    textTool({
      name: 'lma_import_preview',
      description: 'CSV 导入第一步：解析并预览。提供文件路径 path 或文件内容 content（UTF-8，≤5000 行，≤5MB），自动识别列名（支持 WCA 模板：company/emails/contacts/networks/profile 等），返回字段映射、合法/异常/重复统计与前 15 行样例，以及用于确认导入的 batch_id',
      parameters: {
        path: { type: 'string', description: 'CSV 文件绝对路径（Harness 工作区内的文件）' },
        content: { type: 'string', description: 'CSV 文件内容（当没有路径时）' },
        default_country: { type: 'string', description: '默认国家（用于缺失国家字段填充，如 NL）' },
      },
      async execute(args) {
        return previewImport(db, {
          path: args.path ? String(args.path) : undefined,
          content: args.content ? String(args.content) : undefined,
          defaultCountry: args.default_country ? String(args.default_country) : undefined,
        })
      },
    }),

    textTool({
      name: 'lma_import_confirm',
      description: 'CSV 导入第二步：确认导入。必填 batch_id（来自 lma_import_preview）、dedupe_strategy（skip 跳过已有 / update 更新已有 / create 新建）、source_note（数据来源备注，合规必填）。可选 default_country/default_language 填充缺失字段。返回成功/更新/跳过/失败数与失败明细',
      parameters: {
        batch_id: { type: 'string', required: true, description: '预览阶段返回的 batch_id' },
        dedupe_strategy: { type: 'string', required: true, enum: ['skip', 'update', 'create'], description: '重复处理策略' },
        source_note: { type: 'string', required: true, description: '数据来源备注（合规溯源，如 WCA 导出 2026-09）' },
        default_country: { type: 'string', description: '默认国家（缺失字段填充）' },
        default_language: { type: 'string', description: '默认语言（如 en）' },
      },
      async execute(args) {
        const admin = requireAdmin(db)
        if (!admin.ok) throw new Error(admin.error)
        const report = confirmImport(db, String(args.batch_id ?? ''), {
          strategy: String(args.dedupe_strategy) as 'skip' | 'update' | 'create',
          sourceNote: String(args.source_note ?? ''),
          defaultCountry: args.default_country ? String(args.default_country) : undefined,
          defaultLanguage: args.default_language ? String(args.default_language) : undefined,
        }, admin.operator)
        auditImport(db, admin.operator, report)
        return { report, failures_csv_hint: '失败明细已包含在上方 report.failures 中，可按行修正后重新导入' }
      },
    }),

    textTool({
      name: 'lma_import_logs',
      description: '查看最近的 CSV 导入记录（操作人/文件名/条数/结果）',
      parameters: { limit: { type: 'number', description: '条数，默认 10' } },
      execute(args) {
        const rows = db.prepare(
          `SELECT id, batch_id, username, source_note, dedupe_strategy, total_rows, success_rows, updated_rows, skipped_rows, failed_rows, created_at
           FROM import_log ORDER BY id DESC LIMIT ?`,
        ).all(num(args.limit, 10)) as unknown[]
        return { logs: rows }
      },
    }),

    // ---------- 导出 ----------
    textTool({
      name: 'lma_export_csv',
      description: '按筛选条件导出供应商名单为 CSV（含 BOM，Excel 可直接打开）。可选 country/status/关键词。返回完整 CSV 文本',
      parameters: {
        country: { type: 'string', description: '按国家筛选' },
        status: { type: 'string', description: '按状态筛选' },
        q: { type: 'string', description: '关键词（公司名/邮箱/联系人/主营）' },
      },
      async execute(args) {
        const perm = requireUser(db)
        if (!perm.ok) throw new Error(perm.error)
        const r = exportSuppliersCsv(db, {
          country: args.country ? String(args.country) : undefined,
          status: args.status ? String(args.status) : undefined,
          q: args.q ? String(args.q) : undefined,
        }, perm.operator)
        audit(db, perm.operator, 'export', 'supplier', null, { rows: r.rows })
        return `共 ${r.rows} 行。CSV 内容如下：\n\n${r.csv}`
      },
    }),

    // ---------- 供应商 ----------
    textTool({
      name: 'lma_suppliers',
      description: '查询供应商列表。支持按国家/状态/关键词筛选。返回按国家分组的结果、总数与各时区当地时间',
      parameters: {
        country: { type: 'string', description: '国家代码或名称，如 NL' },
        status: { type: 'string', description: '状态：new/matched/drafted/approved/sent/replied/follow_up/unsubscribed/invalid' },
        q: { type: 'string', description: '关键词' },
        page: { type: 'number', description: '页码，默认 1' },
        size: { type: 'number', description: '每页条数，默认 20' },
      },
      execute(args) {
        const where = ['deleted_at IS NULL']
        const a: unknown[] = []
        if (args.country) { where.push('country = ?'); a.push(args.country) }
        if (args.status) { where.push('status = ?'); a.push(args.status) }
        if (args.q) { where.push('(company_name LIKE ? OR email LIKE ? OR contact_name LIKE ? OR business LIKE ?)'); const l = `%${args.q}%`; a.push(l, l, l, l) }
        const page = Math.max(1, num(args.page, 1))
        const size = Math.min(100, num(args.size, 20))
        const w = where.join(' AND ')
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM supplier WHERE ${w}`).get(...a) as { c: number }).c
        const rows = db.prepare(
          `SELECT id, company_name, contact_name, email, country, timezone, status, match_score, preferred_language, source
           FROM supplier WHERE ${w} ORDER BY country, timezone, company_name LIMIT ? OFFSET ?`,
        ).all(...a, size, (page - 1) * size) as Array<Record<string, unknown>>
        const groups: Array<Record<string, unknown>> = []
        const idx = new Map<string, number>()
        for (const r of rows) {
          const key = `${String(r.country ?? '未知')}::${String(r.timezone ?? '')}`
          let g = groups[idx.get(key) ?? -1]
          if (!g) {
            g = { country: r.country ?? '未知', timezone: r.timezone, localTime: localTimeString(String(r.timezone ?? '')), suppliers: [] }
            idx.set(key, groups.length)
            groups.push(g)
          }
          ;(g.suppliers as unknown[]).push(r)
        }
        return { total, page, size, groups }
      },
    }),

    textTool({
      name: 'lma_supplier_detail',
      description: '查看单个供应商详情：联系方式/主营/WCA 网络/公司介绍/匹配分析 + 邮件往来时间线 + 草稿历史',
      parameters: { id: { type: 'number', required: true, description: '供应商 ID' } },
      execute(args) {
        const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(num(args.id, 0))
        if (!s) throw new Error('供应商不存在')
        const events = db.prepare(
          `SELECT e.*, d.subject AS draft_subject FROM email_event e LEFT JOIN email_draft d ON d.id = e.draft_id
           WHERE e.supplier_id = ? ORDER BY e.event_time DESC, e.id DESC LIMIT 50`,
        ).all(num(args.id, 0)) as unknown[]
        const drafts = db.prepare(
          'SELECT id, subject, status, language, match_score, created_at, reviewed_at, reject_reason FROM email_draft WHERE supplier_id = ? ORDER BY id DESC LIMIT 20',
        ).all(num(args.id, 0)) as unknown[]
        return { supplier: s, events, drafts }
      },
    }),

    textTool({
      name: 'lma_supplier_edit',
      description: '手动编辑供应商信息（公司名/联系人/邮箱/电话/传真/官网/主营/网络/国家/地区/语言等）。邮箱或国家变更会自动重新规范化（小写、时区推断）',
      parameters: {
        id: { type: 'number', required: true, description: '供应商 ID' },
        company_name: { type: 'string' }, contact_name: { type: 'string' }, email: { type: 'string' },
        phone: { type: 'string' }, fax: { type: 'string' }, website: { type: 'string' },
        business: { type: 'string' }, networks: { type: 'string' }, country: { type: 'string' },
        region: { type: 'string' }, preferred_language: { type: 'string' },
      },
      async execute(args) {
        const perm = requireAdmin(db)
        if (!perm.ok) throw new Error(perm.error)
        const id = num(args.id, 0)
        const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id)
        if (!s) throw new Error('供应商不存在')
        const operator = perm.operator
        const allowed = ['company_name', 'contact_name', 'email', 'phone', 'fax', 'website', 'business', 'networks', 'country', 'region', 'preferred_language']
        const sets: string[] = []
        const a: unknown[] = []
        const changed: Record<string, unknown> = {}
        for (const k of allowed) {
          if (args[k] !== undefined) {
            const v = String(args[k]).trim()
            if (k === 'email') { sets.push('email = ?'); a.push(v.toLowerCase()) }
            else if (k === 'country') {
              const ct = countryToTimezone(v)
              sets.push('country = ?'); a.push(ct ? ct.country : v)
              sets.push('timezone = ?'); a.push(ct ? ct.timezone : null)
            } else { sets.push(`${k} = ?`); a.push(v) }
            changed[k] = args[k]
          }
        }
        if (sets.length) {
          a.push(id)
          db.prepare(`UPDATE supplier SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...a)
          audit(db, operator, 'edit_supplier', 'supplier', id, changed)
        }
        return { ok: true }
      },
    }),

    textTool({
      name: 'lma_supplier_delete',
      description: '软删除供应商（保留审计与历史记录）',
      parameters: { id: { type: 'number', required: true, description: '供应商 ID' } },
      execute(args) {
        const perm = requireAdmin(db)
        if (!perm.ok) throw new Error(perm.error)
        const id = num(args.id, 0)
        const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id) as { email: string } | undefined
        if (!s) throw new Error('供应商不存在')
        db.prepare(`UPDATE supplier SET deleted_at = ?, updated_at = datetime('now') WHERE id = ?`).run(sqlNow(), id)
        audit(db, perm.operator, 'delete_supplier', 'supplier', id, { email: s.email })
        return { ok: true }
      },
    }),

    // ---------- AI 匹配与草稿生成 ----------
    textTool({
      name: 'lma_match',
      description: '对供应商按需触发 AI 匹配：对比我方（Transtar）业务画像与对方资料，输出匹配度评分（0-100）与建议合作切入点，写入供应商',
      parameters: { supplier_id: { type: 'number', required: true, description: '供应商 ID' } },
      async execute(args) {
        const id = num(args.supplier_id, 0)
        const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id)
        if (!s) throw new Error('供应商不存在')
        const match = await matchSupplier(db, s as never)
        db.prepare(`UPDATE supplier SET match_score = ?, match_analysis = ?, status = 'matched', updated_at = datetime('now') WHERE id = ?`)
          .run(match.score, match.analysis, id)
        audit(db, op(args), 'ai_match', 'supplier', id, { score: match.score })
        return { score: match.score, analysis: match.analysis }
      },
    }),

    textTool({
      name: 'lma_draft',
      description: '为供应商生成个性化推广邮件草稿（按对方首选语言；页脚自动附加来源声明与退订链接）。草稿进入审核队列',
      parameters: { supplier_id: { type: 'number', required: true, description: '供应商 ID' } },
      async execute(args) {
        const id = num(args.supplier_id, 0)
        const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id)
        if (!s) throw new Error('供应商不存在')
        let match = { score: Number((s as { match_score: number | null }).match_score ?? 0), analysis: String((s as { match_analysis: string | null }).match_analysis ?? '') }
        if (!match.analysis) match = await matchSupplier(db, s as never)
        const draft = await generateDraft(db, s as never, match, BASE_URL)
        const info = db.prepare(
          `INSERT INTO email_draft (supplier_id, subject, body, language, match_analysis, match_score, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, datetime('now'), datetime('now'))`,
        ).run(id, draft.subject, draft.body, (s as { preferred_language: string | null }).preferred_language ?? 'en', match.analysis, match.score, op(args))
        db.prepare(`UPDATE supplier SET status = 'drafted', updated_at = datetime('now') WHERE id = ?`).run(id)
        audit(db, op(args), 'create_draft', 'email_draft', Number(info.lastInsertRowid), { supplierId: id })
        return { draft_id: Number(info.lastInsertRowid), subject: draft.subject, body: draft.body, footer_hint: '发送时自动追加来源声明与退订链接' }
      },
    }),

    // ---------- 审核 ----------
    textTool({
      name: 'lma_review_queue',
      description: '查看审核队列（待审草稿默认 draft 状态）。每封含匹配分析、语言与对应供应商',
      parameters: { status: { type: 'string', enum: ['draft', 'approved', 'rejected'], description: '状态过滤，默认 draft' }, page: { type: 'number' }, size: { type: 'number' } },
      execute(args) {
        const status = String(args.status ?? 'draft')
        const page = Math.max(1, num(args.page, 1))
        const size = Math.min(100, num(args.size, 20))
        const total = (db.prepare('SELECT COUNT(*) AS c FROM email_draft WHERE status = ?').get(status) as { c: number }).c
        const drafts = db.prepare(
          `SELECT d.id, d.supplier_id, d.subject, d.body, d.language, d.match_score, d.match_analysis, d.created_at,
                  s.company_name, s.email, s.country
           FROM email_draft d JOIN supplier s ON s.id = d.supplier_id
           WHERE d.status = ? AND s.deleted_at IS NULL ORDER BY d.id DESC LIMIT ? OFFSET ?`,
        ).all(status, size, (page - 1) * size) as unknown[]
        return { total, page, size, drafts }
      },
    }),

    textTool({
      name: 'lma_review',
      description: '审核草稿：approve 批准 / approve_with_edit 改后批准（需 subject/body）/ reject 驳回（需 reason）。审核人与时间自动留痕',
      parameters: {
        draft_id: { type: 'number', required: true, description: '草稿 ID' },
        action: { type: 'string', required: true, enum: ['approve', 'approve_with_edit', 'reject'], description: '审核动作' },
        subject: { type: 'string', description: '改后批准时的主题' },
        body: { type: 'string', description: '改后批准时的正文' },
        reason: { type: 'string', description: '驳回原因（驳回必填）' },
      },
      async execute(args) {
        const perm = requireUser(db)
        if (!perm.ok) throw new Error(perm.error)
        const id = num(args.draft_id, 0)
        const draft = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(id) as { status: string; supplier_id: number } | undefined
        if (!draft) throw new Error('草稿不存在')
        if (draft.status !== 'draft') throw new Error('只有 draft 状态的草稿可审核')
        const operator = perm.operator
        const action = String(args.action)
        if (action === 'reject') {
          const reason = String(args.reason ?? '').trim()
          if (!reason) throw new Error('驳回必须填写原因')
          db.prepare(`UPDATE email_draft SET status = 'rejected', reject_reason = ?, reviewer = ?, reviewed_at = datetime('now') WHERE id = ?`).run(reason, operator, id)
          db.prepare(`UPDATE supplier SET status = 'matched', updated_at = datetime('now') WHERE id = ?`).run(draft.supplier_id)
          audit(db, operator, 'review_reject', 'email_draft', id, { reason })
          return { ok: true, status: 'rejected' }
        }
        if (action === 'approve_with_edit') {
          const subject = String(args.subject ?? '').trim()
          const body = String(args.body ?? '').trim()
          if (!subject || !body) throw new Error('改后批准必须提供 subject 与 body')
          db.prepare(`UPDATE email_draft SET subject = ?, body = ?, status = 'approved', reviewer = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
            .run(subject, body, operator, id)
        } else {
          db.prepare(`UPDATE email_draft SET status = 'approved', reviewer = ?, reviewed_at = datetime('now') WHERE id = ?`).run(operator, id)
        }
        db.prepare(`UPDATE supplier SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(draft.supplier_id)
        audit(db, operator, action === 'approve_with_edit' ? 'review_approve_edit' : 'review_approve', 'email_draft', id, { supplierId: draft.supplier_id })
        return { ok: true, status: 'approved' }
      },
    }),

    // ---------- 发送与追踪 ----------
    textTool({
      name: 'lma_send',
      description: '将已批准（approved）的草稿加入发送队列。发送前自动检查：退订名单（实时生效）、邮箱格式、节流间隔、每日上限、对方当地时间工作时段。返回预计发送时间',
      parameters: { draft_id: { type: 'number', required: true, description: '草稿 ID' } },
      execute(args) {
        const perm = requireUser(db)
        if (!perm.ok) throw new Error(perm.error)
        const id = num(args.draft_id, 0)
        // 守卫（状态/幂等/供应商有效性）与 Web 层共用同一份实现
        const r = requestSend(db, id)
        if (!r.ok) throw new Error(r.error ?? '发送失败')
        audit(db, perm.operator, 'send_request', 'email_draft', id, {
          queued: r.queued, dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null, reason: r.reason,
        })
        return { queued: r.queued, dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null, reason: r.reason ?? null }
      },
    }),

    textTool({
      name: 'lma_send_queue',
      description: '查看发送队列状态：待发项、今日已发数、每日上限、节流间隔',
      parameters: {},
      execute() {
        return { pending: queueSnapshot(), todaySent: todaySentCount(db), policy: getSendPolicy(db) }
      },
    }),

    textTool({
      name: 'lma_events',
      description: '查询邮件事件（sent/delivered/replied/bounced/unsubscribed），可按供应商或类型过滤',
      parameters: { supplier_id: { type: 'number', description: '供应商 ID' }, type: { type: 'string', enum: ['sent', 'delivered', 'replied', 'bounced', 'unsubscribed'] }, limit: { type: 'number' } },
      execute(args) {
        const where: string[] = []
        const a: unknown[] = []
        if (args.supplier_id) { where.push('supplier_id = ?'); a.push(num(args.supplier_id, 0)) }
        if (args.type) { where.push('event_type = ?'); a.push(args.type) }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
        const rows = db.prepare(`SELECT * FROM email_event ${w} ORDER BY event_time DESC, id DESC LIMIT ?`).all(...a, num(args.limit, 20)) as unknown[]
        return { events: rows }
      },
    }),

    textTool({
      name: 'lma_event_record',
      description: '人工补录邮件事件（管理员；测试或无 IMAP 环境使用）：replied 回复（标记需人工处理）/ bounced 退信（标记邮箱无效）/ unsubscribed 退订（加入退订名单并停发）/ delivered',
      parameters: {
        supplier_id: { type: 'number', required: true, description: '供应商 ID' },
        type: { type: 'string', required: true, enum: ['delivered', 'replied', 'bounced', 'unsubscribed'], description: '事件类型' },
        note: { type: 'string', description: '备注' },
      },
      execute(args) {
        const admin = requireAdmin(db)
        if (!admin.ok) throw new Error(admin.error)
        const id = num(args.supplier_id, 0)
        const s = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(id) as { id: number; email: string } | undefined
        if (!s) throw new Error('供应商不存在')
        applyResult(db, s, String(args.type) as 'delivered' | 'replied' | 'bounced' | 'unsubscribed', { manual: true, note: args.note ?? null }, admin.operator)
        audit(db, admin.operator, 'record_event', 'supplier', id, { type: args.type, note: args.note })
        return { ok: true }
      },
    }),

    // ---------- 退订 ----------
    textTool({
      name: 'lma_unsubscribes',
      description: '查看退订名单（所有发送前必查，实时生效）',
      parameters: {},
      execute() {
        const rows = db.prepare('SELECT id, email, source, unsubscribed_at, note FROM unsubscribe_list ORDER BY id DESC LIMIT 500').all() as unknown[]
        return { list: rows }
      },
    }),

    textTool({
      name: 'lma_unsubscribe_add',
      description: '手动添加退订邮箱（合规操作，写审计日志）。同步将该邮箱的供应商标记为退订并停止一切发送',
      parameters: { email: { type: 'string', required: true, description: '邮箱' }, note: { type: 'string', description: '备注' } },
      execute(args) {
        // 退订维护按产品决策放开给 staff（一线同事常最先收到"请退订"的回信）
        const perm = requireUser(db)
        if (!perm.ok) throw new Error(perm.error)
        const email = String(args.email ?? '').toLowerCase().trim()
        if (!isValidEmail(email)) throw new Error('邮箱格式错误')
        const operator = perm.operator
        db.prepare('INSERT OR IGNORE INTO unsubscribe_list (email, source, unsubscribed_at, handled_by, note) VALUES (?, ?, ?, ?, ?)')
          .run(email, 'manual', sqlNow(), operator, String(args.note ?? '').trim() || null)
        db.prepare(`UPDATE supplier SET status = 'unsubscribed', updated_at = datetime('now') WHERE email = ? AND deleted_at IS NULL`).run(email)
        audit(db, operator, 'unsubscribe_manual', 'unsubscribe_list', null, { email, note: args.note })
        return { ok: true }
      },
    }),

    // ---------- 配置 ----------
    textTool({
      name: 'lma_config_get',
      description: '查看系统配置：我方业务画像（Transtar）、邮件模板（页脚/禁用词/字数上限）、发送策略（节流/上限/工作时段/自动跟进）',
      parameters: {},
      execute() {
        return { profile: getProfile(db), email_template: getEmailTemplate(db), send_policy: getSendPolicy(db) }
      },
    }),

    textTool({
      name: 'lma_config_update',
      description: '更新系统配置（管理员）。section=profile 更新业务画像；section=email_template 更新邮件模板；section=send_policy 更新发送策略。传入要修改的字段即可',
      parameters: {
        section: { type: 'string', required: true, enum: ['profile', 'email_template', 'send_policy'], description: '配置分区' },
        company_name: { type: 'string', description: 'profile：公司名称' },
        intro: { type: 'string', description: 'profile：公司简介' },
        services: { type: 'string', description: 'profile：服务列表（分号分隔）' },
        strengths: { type: 'string', description: 'profile：优势列表（分号分隔）' },
        target_markets: { type: 'string', description: 'profile：目标市场国家代码（逗号分隔，如 NL,DE）' },
        footer_source: { type: 'string', description: 'email_template：页脚来源声明（{source} 占位符）' },
        banned_words: { type: 'string', description: 'email_template：禁用词（逗号分隔）' },
        subject_max: { type: 'number', description: 'email_template：主题字数上限' },
        body_max_words: { type: 'number', description: 'email_template：正文字数上限' },
        interval_minutes: { type: 'number', description: 'send_policy：发送节流间隔（分钟）' },
        daily_limit: { type: 'number', description: 'send_policy：每日发送上限' },
        check_working_hours: { type: 'boolean', description: 'send_policy：是否检查对方工作时段' },
        work_start: { type: 'number', description: 'send_policy：工作时段开始（对方当地时间）' },
        work_end: { type: 'number', description: 'send_policy：工作时段结束' },
        auto_followup: { type: 'boolean', description: 'send_policy：是否自动批准跟进邮件' },
        followup_after_days: { type: 'number', description: 'send_policy：跟进间隔天数' },
        followup_max: { type: 'number', description: 'send_policy：跟进最大次数' },
      },
      async execute(args) {
        const admin = requireAdmin(db)
        if (!admin.ok) throw new Error(admin.error)
        const section = String(args.section)
        if (section === 'profile') {
          const cur = getProfile(db)
          const next = { ...cur }
          if (args.company_name !== undefined) next.companyName = String(args.company_name)
          if (args.intro !== undefined) next.intro = String(args.intro)
          if (args.services !== undefined) next.services = splitMulti(args.services, ';')
          if (args.strengths !== undefined) next.strengths = splitMulti(args.strengths, ';')
          if (args.target_markets !== undefined) next.targetMarkets = String(args.target_markets).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
          db.prepare(`INSERT INTO app_config (key, value, updated_at, updated_by) VALUES ('profile', ?, datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`)
            .run(JSON.stringify(next), admin.operator)
        } else if (section === 'email_template') {
          const cur = getEmailTemplate(db)
          const next = { ...cur }
          if (args.footer_source !== undefined) next.footerSource = String(args.footer_source)
          if (args.banned_words !== undefined) next.bannedWords = String(args.banned_words).split(',').map((s) => s.trim()).filter(Boolean)
          if (args.subject_max !== undefined) next.subjectMax = num(args.subject_max, cur.subjectMax)
          if (args.body_max_words !== undefined) next.bodyMaxWords = num(args.body_max_words, cur.bodyMaxWords)
          db.prepare(`INSERT INTO app_config (key, value, updated_at, updated_by) VALUES ('email_template', ?, datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`)
            .run(JSON.stringify(next), admin.operator)
        } else if (section === 'send_policy') {
          const cur = getSendPolicy(db)
          const next = { ...cur }
          if (args.interval_minutes !== undefined) next.intervalMinutes = num0(args.interval_minutes, cur.intervalMinutes)
          if (args.daily_limit !== undefined) next.dailyLimit = num(args.daily_limit, cur.dailyLimit)
          if (args.check_working_hours !== undefined) next.checkWorkingHours = Boolean(args.check_working_hours)
          if (args.work_start !== undefined) next.workStart = num(args.work_start, cur.workStart)
          if (args.work_end !== undefined) next.workEnd = num(args.work_end, cur.workEnd)
          if (args.auto_followup !== undefined) next.autoFollowup = Boolean(args.auto_followup)
          if (args.followup_after_days !== undefined) next.followupAfterDays = num(args.followup_after_days, cur.followupAfterDays)
          if (args.followup_max !== undefined) next.followupMax = num(args.followup_max, cur.followupMax)
          db.prepare(`INSERT INTO app_config (key, value, updated_at, updated_by) VALUES ('send_policy', ?, datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`)
            .run(JSON.stringify(next), admin.operator)
        } else {
          throw new Error('未知配置分区')
        }
        audit(db, admin.operator, 'update_config', 'app_config', null, { section })
        return { ok: true, section }
      },
    }),

    // ---------- 跟进 ----------
    textTool({
      name: 'lma_followup_check',
      description: '触发跟进规则检查（admin / staff 均可）：对 3 天未回复且未超上限的已发送供应商生成跟进草稿。默认只生成草稿进审核队列（autoFollowup=false）',
      parameters: {},
      async execute(args) {
        const perm = requireUser(db)
        if (!perm.ok) throw new Error(perm.error)
        const result = await checkFollowups(db, perm.operator)
        audit(db, perm.operator, 'followup_check', 'supplier', null, result)
        return result
      },
    }),

    // ---------- 项目知识 / 帮助 ----------
    textTool({
      name: 'lma_project_knowledge',
      description: '查询本系统（LMA 物流推广智能体系统）的项目知识：数据模型、业务流程、合规要求、配置说明、常见操作指引。用户问"这个系统怎么用/合规要求/怎么导入"等问题时优先调用',
      parameters: { topic: { type: 'string', description: '可选主题：import/export/match/draft/review/send/track/compliance/config/overview' } },
      execute(args) {
        const topic = String(args.topic ?? '').toLowerCase()
        if (topic && PROJECT_KNOWLEDGE[topic]) return PROJECT_KNOWLEDGE[topic]
        return PROJECT_KNOWLEDGE.overview
      },
    }),
  ]
}

// 供测试导出（批次暂存已抽到 importing.ts）
export { getBatch, stageBatch } from './importing.ts'

// Harness 集成测试：把 LMA 插件工具注册进 dsh 的 ToolRuntime，用 ctx.tools.execute 跑完整业务流
// 装配方式对齐仓库 packages/core/tools/tests/*.spec.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { openDb } from '../src/db.ts'
import { buildLmaTools } from '../src/tools.ts'
import { toDshTools } from '../src/tools-dsh.ts'

const FIXTURE = path.join(__dirname, 'fixtures', 'wca_netherlands.csv')
const signal = new AbortController().signal
let ctx: Context
let tmp: string

function exec(name: string, args: unknown) {
  return { signal, callId: ToolCallId('c1'), name, arguments: args }
}

async function call(name: string, args: unknown): Promise<{ value: unknown; content: unknown; isError: boolean }> {
  const r = await ctx.tools.execute(exec(name, args))
  return r as { value: unknown; content: unknown; isError: boolean }
}

const val = (r: { value: unknown }) => JSON.parse(String(r.value))
const txt = (r: { content: unknown }) =>
  (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join(' ')

/** 工具层的固定服务身份（与 vitest.config 的 LMA_AGENT_USER 一致） */
const AGENT = process.env.LMA_AGENT_USER ?? 'test-agent'
let dbRef: ReturnType<typeof openDb>
/** 切换服务身份在 lma_user 里的角色/状态，用于验证后端角色强制 */
function setAgent(role: 'admin' | 'staff', status: 'active' | 'disabled' = 'active'): void {
  dbRef.prepare('UPDATE lma_user SET role = ?, status = ? WHERE username = ?').run(role, status, AGENT)
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lma-harness-'))
  dbRef = openDb(path.join(tmp, 'harness.db'))
  const db = dbRef
  // 工具以固定服务身份执行：先在库里登记该身份（角色由各用例按需切换）
  db.prepare("INSERT INTO lma_user (username, password_hash, role, status) VALUES (?, 'x', 'admin', 'active')").run(AGENT)
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const tool of toDshTools(buildLmaTools(db))) ctx.tools.register(tool)
})

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('插件在 dsh 中的可加载性', () => {
  it('lma_* 工具全部注册进 ToolRuntime schema', () => {
    const names = ctx.tools.schemas().map((s) => s.name)
    const lma = names.filter((n) => n.startsWith('lma_'))
    expect(lma.length).toBeGreaterThanOrEqual(20)
    for (const must of ['lma_dashboard', 'lma_import_preview', 'lma_import_confirm', 'lma_match', 'lma_draft',
      'lma_review', 'lma_send', 'lma_send_queue', 'lma_events', 'lma_unsubscribes', 'lma_config_get',
      'lma_project_knowledge']) {
      expect(lma).toContain(must)
    }
  })

  it('空库 dashboard 正常返回', async () => {
    const r = await call('lma_dashboard', {})
    expect(r.isError).toBe(false)
    const d = val(r)
    expect(d.supplierTotal).toBe(0)
  })
})

describe('完整业务流（导入 → 匹配 → 草稿 → 审核 → 发送入队）', () => {
  let batchId = ''
  let supplierId = 0
  let draftId = 0

  it('1) 导入预览：解析真实 WCA 文件', async () => {
    const content = fs.readFileSync(FIXTURE, 'utf8')
    const r = await call('lma_import_preview', { content })
    expect(r.isError).toBe(false)
    const p = val(r)
    expect(p.stats.total).toBe(61)
    expect(p.stats.valid).toBe(61)
    batchId = p.batch_id
  })

  it('2) 服务身份为 staff 时，管理员专属操作被拒绝（后端角色强制）', async () => {
    setAgent('staff')
    try {
      const r = await call('lma_import_confirm', { batch_id: batchId, dedupe_strategy: 'skip', source_note: 'WCA' })
      expect(r.isError).toBe(true)
      expect(txt(r)).toMatch(/管理员/)
    } finally {
      setAgent('admin')
    }
  })

  it('3) 确认导入成功', async () => {
    const r = await call('lma_import_confirm', { batch_id: batchId, dedupe_strategy: 'skip', source_note: 'WCA Netherlands 2026-09', default_country: 'NL' })
    expect(r.isError).toBe(false)
    const rep = val(r)
    expect(rep.report.successRows).toBe(61)
  })

  it('4) 供应商列表按国家分组且显示当地时间', async () => {
    const r = await call('lma_suppliers', { country: 'NL', size: 5 })
    expect(r.isError).toBe(false)
    const s = val(r)
    expect(s.total).toBe(61)
    expect(s.groups[0].country).toBe('NL')
    expect(s.groups[0].localTime).toMatch(/UTC/)
    supplierId = s.groups[0].suppliers[0].id
  })

  it('5) AI 匹配', async () => {
    const r = await call('lma_match', { supplier_id: supplierId })
    expect(r.isError).toBe(false)
    const m = val(r)
    expect(m.score).toBeGreaterThanOrEqual(0)
    expect(m.analysis.length).toBeGreaterThan(10)
  })

  it('6) 生成草稿（页脚发送时自动追加）', async () => {
    const r = await call('lma_draft', { supplier_id: supplierId })
    expect(r.isError).toBe(false)
    const d = val(r)
    draftId = d.draft_id
    expect(d.subject.length).toBeLessThanOrEqual(80)
    expect(d.body).toContain('Transtar')
  })

  it('7) 审核：先驳回缺原因报错，再批准', async () => {
    const bad = await call('lma_review', { draft_id: draftId, action: 'reject' })
    expect(bad.isError).toBe(true)
    const ok = await call('lma_review', { draft_id: draftId, action: 'approve' })
    expect(ok.isError).toBe(false)
    const q = await call('lma_review_queue', { status: 'approved' })
    const qq = val(q)
    expect(qq.total).toBeGreaterThanOrEqual(1)
  })

  it('8) 批准后发送入队（非工作时段自动排队）', async () => {
    const r = await call('lma_send', { draft_id: draftId })
    expect(r.isError).toBe(false)
    const s = val(r)
    expect(s.queued).toBeDefined()
    const q = await call('lma_send_queue', {})
    expect(q.isError).toBe(false)
  })

  it('8b) 重复发送同一草稿被拒绝（幂等）', async () => {
    const r = await call('lma_send', { draft_id: draftId })
    expect(r.isError).toBe(true)
    const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join(' ')
    expect(text).toMatch(/队列中|已发送/)
  })

  it('9) 事件补录（管理员）：回复 → 需人工处理', async () => {
    const r = await call('lma_event_record', { supplier_id: supplierId, type: 'replied', note: 'test' })
    expect(r.isError).toBe(false)
    const d = await call('lma_supplier_detail', { id: supplierId })
    const dd = val(d)
    expect(dd.supplier.status).toBe('replied')
    expect(dd.events[0].event_type).toBe('replied')
  })
})

describe('导出 / 退订 / 跟进（关键合规路径）', () => {
  it('导出 CSV：带 BOM、含状态与业务字段、记录导出日志', async () => {
    const r = await call('lma_export_csv', { country: 'NL' })
    expect(r.isError).toBe(false)
    const csv = String(r.value)
    expect(csv).toContain('\uFEFF') // BOM 位于 CSV 文本首
    expect(csv).toContain('company_name')
    expect(csv).toContain('status')
    expect(csv).toContain('Noatum Logistics Netherlands B.V.')
  })

  it('手动退订：加入名单 + 同步标记供应商并停发', async () => {
    const s = await call('lma_suppliers', { q: 'noatum', size: 1 })
    const ss = val(s)
    const sid = ss.groups[0].suppliers[0].id
    const email = ss.groups[0].suppliers[0].email
    const r = await call('lma_unsubscribe_add', { email, note: '客户明确要求' })
    expect(r.isError).toBe(false)
    const list = await call('lma_unsubscribes', {})
    expect(JSON.stringify(list.value)).toContain(email)
    const d = await call('lma_supplier_detail', { id: sid })
    expect(val(d).supplier.status).toBe('unsubscribed')
  })

  it('跟进检查可执行（默认只生成草稿）', async () => {
    const r = await call('lma_followup_check', { operator: 'test-admin' })
    expect(r.isError).toBe(false)
    const f = val(r)
    expect(typeof f.scanned).toBe('number')
    expect(f.autoFollowup).toBe(false)
  })
})

describe('配置与知识库', () => {
  it('config_get 返回 Transtar 画像与发送策略', async () => {
    const r = await call('lma_config_get', {})
    expect(r.isError).toBe(false)
    const c = val(r)
    expect(c.profile.companyName).toContain('Transtar')
    expect(c.send_policy.intervalMinutes).toBe(3)
    expect(c.send_policy.dailyLimit).toBe(20)
  })

  it('config_update 仅管理员可用（服务身份为 staff 时被拒）', async () => {
    setAgent('staff')
    try {
      const denied = await call('lma_config_update', { section: 'send_policy', daily_limit: 30 })
      expect(denied.isError).toBe(true)
      expect(txt(denied)).toMatch(/管理员/)
    } finally {
      setAgent('admin')
    }
    const ok = await call('lma_config_update', { section: 'send_policy', daily_limit: 30 })
    expect(ok.isError).toBe(false)
  })

  it('project_knowledge 覆盖合规/导入/发送/入口主题', async () => {
    const r = await call('lma_project_knowledge', { topic: 'compliance' })
    expect(r.isError).toBe(false)
    expect(String(r.value)).toMatch(/退订/)
    // 入口主题必须说清"一次登录、两处通用"，否则 Agent 会答错访问方式
    const entry = await call('lma_project_knowledge', { topic: 'entry' })
    expect(String(entry.value)).toMatch(/登录页/)
    expect(String(entry.value)).toMatch(/不需要第二次登录/)
    const ov = await call('lma_project_knowledge', {})
    expect(String(ov.value)).toContain('LMA')
  })
})

describe('角色权限（服务身份 + lma_user 角色）', () => {
  it('服务身份为 admin：管理员专属操作放行', async () => {
    setAgent('admin')
    expect((await call('lma_followup_check', {})).isError).toBe(false)
    expect((await call('lma_unsubscribe_add', { email: 'admin-can-unsub@example.com' })).isError).toBe(false)
  })

  it('服务身份为 staff：业务操作放行，管理员专属被拒', async () => {
    setAgent('staff')
    try {
      // 业务操作（导出 / 审核 / 发送 / 跟进 / 退订维护）
      expect((await call('lma_export_csv', {})).isError).toBe(false)
      expect((await call('lma_followup_check', {})).isError).toBe(false)
      expect((await call('lma_unsubscribe_add', { email: 'staff-can-unsub@example.com' })).isError).toBe(false)

      const send = await call('lma_send', { draft_id: 999999 })
      expect(send.isError).toBe(true)
      expect(txt(send)).not.toMatch(/权限/) // 失败原因是"草稿不存在"，说明权限层放行了
      expect(txt(send)).toMatch(/草稿不存在/)

      // 管理员专属
      for (const [tool, args] of [
        ['lma_import_confirm', { batch_id: 'x', dedupe_strategy: 'skip', source_note: 'y' }],
        ['lma_config_update', { section: 'send_policy', daily_limit: 9 }],
        ['lma_supplier_edit', { id: 999999, company_name: 'X' }],
        ['lma_supplier_delete', { id: 999999 }],
        ['lma_event_record', { supplier_id: 999999, type: 'replied' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = await call(tool, args)
        expect(r.isError, `${tool} 应拒绝 staff`).toBe(true)
        expect(txt(r), `${tool} 的错误应说明缺少管理员权限`).toMatch(/管理员/)
      }
    } finally {
      setAgent('admin')
    }
  })

  it('模型传入的 operator 一律被忽略，无法自封管理员（F-AUTH-07 关键断言）', async () => {
    setAgent('staff')
    try {
      // 过去只要把 operator 填成管理员名字就能提权；现在身份由服务端固定，传什么都没用
      const spoof = await call('lma_config_update', {
        section: 'send_policy', daily_limit: 9, operator: 'test-admin',
      } as Record<string, unknown>)
      expect(spoof.isError).toBe(true)
      expect(txt(spoof)).toMatch(/管理员/)

      const spoof2 = await call('lma_import_confirm', {
        batch_id: 'x', dedupe_strategy: 'skip', source_note: 'y', operator: 'will',
      } as Record<string, unknown>)
      expect(spoof2.isError).toBe(true)
    } finally {
      setAgent('admin')
    }
  })

  it('服务身份被禁用后：受控操作一律拒绝', async () => {
    setAgent('staff', 'disabled')
    try {
      expect((await call('lma_export_csv', {})).isError).toBe(true)
      expect((await call('lma_followup_check', {})).isError).toBe(true)
      expect((await call('lma_import_confirm', { batch_id: 'x', dedupe_strategy: 'skip', source_note: 'y' })).isError).toBe(true)
    } finally {
      setAgent('admin', 'active')
    }
  })
})

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

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lma-harness-'))
  const db = openDb(path.join(tmp, 'harness.db'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const tool of buildLmaTools(db)) ctx.tools.register(tool)
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

  it('2) 非管理员操作被拒绝（角色控制）', async () => {
    const r = await call('lma_import_confirm', { batch_id: batchId, dedupe_strategy: 'skip', source_note: 'WCA', operator: 'outsider' })
    expect(r.isError).toBe(true)
    // 错误文本在 content 中（value 为空）
    const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join(' ')
    expect(text).toMatch(/管理员/)
  })

  it('3) 确认导入成功', async () => {
    const r = await call('lma_import_confirm', { batch_id: batchId, dedupe_strategy: 'skip', source_note: 'WCA Netherlands 2026-09', default_country: 'NL', operator: 'test-admin' })
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
    const ok = await call('lma_review', { draft_id: draftId, action: 'approve', operator: 'test-admin' })
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

  it('9) 事件补录（管理员）：回复 → 需人工处理', async () => {
    const r = await call('lma_event_record', { supplier_id: supplierId, type: 'replied', note: 'test', operator: 'test-admin' })
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
    const r = await call('lma_unsubscribe_add', { email, note: '客户明确要求', operator: 'test-admin' })
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

  it('config_update 需要管理员', async () => {
    const r = await call('lma_config_update', { section: 'send_policy', daily_limit: 30, operator: 'outsider' })
    expect(r.isError).toBe(true)
    const ok = await call('lma_config_update', { section: 'send_policy', daily_limit: 30, operator: 'test-admin' })
    expect(ok.isError).toBe(false)
  })

  it('project_knowledge 覆盖合规/导入/发送主题', async () => {
    const r = await call('lma_project_knowledge', { topic: 'compliance' })
    expect(r.isError).toBe(false)
    expect(String(r.value)).toMatch(/退订/)
    const ov = await call('lma_project_knowledge', {})
    expect(String(ov.value)).toContain('LMA')
  })
})

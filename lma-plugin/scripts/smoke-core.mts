// 快速冒烟：不依赖 dsh 包，直接用 node --experimental-strip-types 运行核心逻辑
// 运行：cd JackyDash-harness/lma-plugin && node --experimental-strip-types --no-warnings scripts/smoke-core.mts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.ts'
import { parseCsv } from '../src/csvparse.ts'
import { autoMapColumns, previewRows, executeImport } from '../src/csvpipeline.ts'
import { matchSupplier, generateDraft, buildFooter, unsubscribeToken } from '../src/ai.ts'
import { enqueue, processDue, initQueueState, isUnsubscribed } from '../src/sendqueue.ts'
import { setConfig, DEFAULT_SEND_POLICY } from '../src/db.ts'
import { applyResult } from '../src/imap.ts'

const fixture = path.join(import.meta.dirname, '..', 'tests', 'fixtures', 'wca_netherlands.csv')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lma-smoke-'))
const db = openDb(path.join(tmp, 'smoke.db'))
setConfig(db, 'send_policy', { ...DEFAULT_SEND_POLICY, intervalMinutes: 0, checkWorkingHours: false, dailyLimit: 100 })
initQueueState(db)

const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error('断言失败: ' + msg); console.log('  ✓', msg) }

// 1. 解析真实 WCA 文件
const { columns, rows } = parseCsv(fs.readFileSync(fixture, 'utf8'))
assert(columns.length === 13, `列数 13（实际 ${columns.length}）`)
assert(rows.length === 61, `数据行 61（实际 ${rows.length}）`)

// 2. 映射 + 预览
const mapping = autoMapColumns(columns)
assert(columns[mapping.email!] === 'emails', 'emails → email')
const { stats } = previewRows(rows, mapping, db, 'NL')
assert(stats.valid === 61, '预览全部合法')

// 3. 导入
const report = executeImport(db, {
  batchId: 'smoke-1', rows, mapping, strategy: 'skip',
  sourceNote: 'WCA Netherlands export 2026-09', defaultCountry: 'NL', username: 'smoke',
})
assert(report.successRows === 61, '导入成功 61 条')
const s = db.prepare('SELECT * FROM supplier WHERE external_id = ?').get('146713') as Record<string, unknown>
assert(s.company_name === 'Noatum Logistics Netherlands B.V.', '公司名正确')
assert(s.country === 'NL' && s.timezone === 'Europe/Amsterdam', '国家/时区推断')
assert(String(s.extra_emails).includes('opsnl@noatumlogistics.com'), '多邮箱拆分')

// 4. AI mock
const sup = db.prepare('SELECT * FROM supplier WHERE id = 1').get() as never
const match = await matchSupplier(db, sup)
assert(match.score >= 0 && match.score <= 100, `匹配评分 ${match.score}`)
const draft = await generateDraft(db, sup, match, 'http://127.0.0.1:3080')
assert(draft.subject.length <= 80, `主题 ≤80（${draft.subject.length}）`)
assert(draft.body.includes('Transtar'), '正文含我方公司名')
const footer = buildFooter(db, sup as never, 'http://127.0.0.1:3080')
assert(footer.includes('/unsubscribe?e=') && footer.includes(unsubscribeToken('contactnl@noatumlogistics.com')), '页脚退订链接')

// 5. 发送（log 模式）
db.prepare(`UPDATE supplier SET status = 'approved' WHERE id = 1`).run()
const draftRow = db.prepare(
  `INSERT INTO email_draft (supplier_id, subject, body, status) VALUES (1, ?, ?, 'approved')`,
).run(draft.subject, draft.body)
const d = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(Number(draftRow.lastInsertRowid)) as { id: number; subject: string; body: string }
const sup1 = db.prepare('SELECT * FROM supplier WHERE id = 1').get() as { id: number; email: string; timezone: string | null; status: string }
const q = enqueue(db, d, sup1)
assert(q.ok === true, '入队成功')
await processDue(db)
const ev = db.prepare(`SELECT * FROM email_event WHERE supplier_id = 1 AND event_type = 'sent'`).get()
assert(!!ev, 'sent 事件落库')
const st = db.prepare('SELECT status FROM supplier WHERE id = 1').get() as { status: string }
assert(st.status === 'sent', '供应商状态 → sent')

// 6. 退订拦截
applyResult(db, { id: 2, email: 'optout@x.com' }, 'unsubscribed', {})
assert(isUnsubscribed(db, 'optout@x.com'), '退订实时生效')
const st2 = db.prepare('SELECT status FROM supplier WHERE email = ?').get('optout@x.com')
assert(!st2, '无该供应商时退订名单独立生效')

console.log('\n全部核心冒烟通过 ✓')
fs.rmSync(tmp, { recursive: true, force: true })

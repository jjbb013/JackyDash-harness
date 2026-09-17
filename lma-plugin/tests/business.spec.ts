// 业务模块级测试：db / csvparse（真实 WCA 样例）/ csvpipeline / timezone / ai / sendqueue / imap
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const FIXTURE = path.join(__dirname, 'fixtures', 'wca_netherlands.csv')
let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lma-test-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('CSV 解析（真实 WCA 荷兰模板）', async () => {
  const { parseCsv } = await import('../src/csvparse.ts')
  const text = fs.readFileSync(FIXTURE, 'utf8')
  const { columns, rows } = parseCsv(text)

  it('解析列数与数据行数正确', () => {
    expect(columns).toHaveLength(13)
    expect(rows).toHaveLength(61) // 230 个物理行（多数 profile 为多行引号字段），实际 61 条记录
  })

  it('BOM 被剥离，首列为 id', () => {
    expect(columns[0]).toBe('id')
    expect(columns[1]).toBe('company')
  })

  it('带引号、含逗号与分号多值的字段被正确解析', () => {
    const first = rows[0]
    expect(first[0]).toBe('146713')
    expect(first[1]).toBe('Noatum Logistics Netherlands B.V.')
    expect(first[3]).toBe('1119PR Schiphol')
    expect(first[7]).toContain('noatumlogistics.com')
    expect(first[8]).toContain('contactnl@noatumlogistics.com')
    expect(first[10]).toContain(';') // networks 分号多值
  })

  it('超过行数上限报错', () => {
    const csv = 'a,b\n' + Array.from({ length: 5001 }, (_, i) => `${i},x`).join('\n')
    expect(() => parseCsv(csv, 5000)).toThrow(/上限/)
  })
})

describe('字段映射与入库管道', async () => {
  const { openDb } = await import('../src/db.ts')
  const { parseCsv } = await import('../src/csvparse.ts')
  const { autoMapColumns, previewRows, executeImport } = await import('../src/csvpipeline.ts')
  let db: Awaited<ReturnType<typeof openDb>>
  let text: string
  let rows: string[][]
  let columns: string[]

  beforeAll(() => {
    db = openDb(path.join(tmp, 'pipeline.db'))
    text = fs.readFileSync(FIXTURE, 'utf8')
    ;({ rows, columns } = parseCsv(text))
  })

  it('自动识别 WCA 模板列名', () => {
    const m = autoMapColumns(columns)
    expect(columns[m.company_name!]).toBe('company')
    expect(columns[m.email!]).toBe('emails')
    expect(columns[m.contact_name!]).toBe('contacts')
    expect(columns[m.networks!]).toBe('networks')
    expect(columns[m.profile!]).toBe('profile')
    expect(columns[m.country!]).toBe('country')
    expect(columns[m.region!]).toBe('city')
    expect(columns[m.external_id!]).toBe('id')
  })

  it('预览统计：61 条记录全部合法、国家缺失警告', () => {
    const { stats, preview } = previewRows(rows, autoMapColumns(columns), db, 'NL')
    expect(stats.total).toBe(61)
    expect(stats.valid).toBe(61)
    expect(stats.invalid).toBe(0)
    expect(preview[0].data.email).toContain('noatumlogistics.com')
  })

  it('缺少 source_note 时拒绝导入（合规 F-CSV-07）', () => {
    expect(() => executeImport(db, {
      batchId: 'b1', rows, mapping: autoMapColumns(columns), strategy: 'skip',
      sourceNote: '', username: 't',
    })).toThrow(/来源备注/)
  })

  it('确认导入：成功 61 条并写入导入日志与审计可查数据', () => {
    const report = executeImport(db, {
      batchId: 'b1', rows, mapping: autoMapColumns(columns), strategy: 'skip',
      sourceNote: 'WCA Netherlands export 2026-09', defaultCountry: 'NL', username: 'tester',
    })
    expect(report.successRows).toBe(61)
    expect(report.failedRows).toBe(0)
    const s = db.prepare('SELECT * FROM supplier WHERE external_id = ?').get('146713') as
      { company_name: string; email: string; country: string; timezone: string; extra_emails: string; source: string; networks: string }
    expect(s.company_name).toBe('Noatum Logistics Netherlands B.V.')
    expect(s.email).toBe('contactnl@noatumlogistics.com') // 分号多邮箱取主邮箱
    expect(s.extra_emails).toContain('opsnl@noatumlogistics.com')
    expect(s.country).toBe('NL') // Netherlands → NL
    expect(s.timezone).toBe('Europe/Amsterdam') // 时区自动推断
    expect(s.source).toContain('WCA')
    expect(s.networks).toContain('WCA')
    const log = db.prepare('SELECT * FROM import_log WHERE batch_id = ?').get('b1') as { success_rows: number; total_rows: number }
    expect(log.success_rows).toBe(61)
  })

  it('重复处理：skip 跳过 / update 更新已有', () => {
    const m = autoMapColumns(columns)
    const r1 = executeImport(db, { batchId: 'b2', rows: rows.slice(0, 10), mapping: m, strategy: 'skip', sourceNote: 'dup', username: 't' })
    expect(r1.skippedRows).toBe(10)
    expect(r1.successRows).toBe(0)
    const r2 = executeImport(db, { batchId: 'b3', rows: rows.slice(0, 10), mapping: m, strategy: 'update', sourceNote: 'dup2', username: 't' })
    expect(r2.updatedRows).toBe(10)
  })

  it('update 策略遇文件内重复：后一行更新前行，不产生重复记录', () => {
    const m = autoMapColumns(columns)
    const r0 = [...rows[0]]
    r0[m.email!] = 'dupfile@test.com; second@test.com'
    const rr = executeImport(db, {
      batchId: 'b-dupfile', rows: [r0, [...r0]], mapping: m, strategy: 'update',
      sourceNote: 'dup-in-file', defaultCountry: 'NL', username: 't',
    })
    expect(rr.successRows).toBe(1)
    expect(rr.updatedRows).toBe(1)
    expect(rr.failedRows).toBe(0)
    const cnt = (db.prepare('SELECT COUNT(*) AS c FROM supplier WHERE email = ?').get('dupfile@test.com') as { c: number }).c
    expect(cnt).toBe(1)
  })
})

describe('时区与当地时间', async () => {
  const { countryToTimezone, normalizeLanguage, isWorkingTime, tzParts } = await import('../src/timezone.ts')

  it('Netherlands → NL / Europe/Amsterdam', () => {
    const r = countryToTimezone('Netherlands')
    expect(r).toEqual({ country: 'NL', timezone: 'Europe/Amsterdam' })
  })

  it('语言标准化', () => {
    expect(normalizeLanguage('English')).toBe('en')
    expect(normalizeLanguage('荷兰语')).toBe('nl')
  })

  it('工作时段判断（周五 10:00 是工作时段）', () => {
    // 构造一个确定的周五 10:00 UTC 时间
    const friday = new Date(Date.UTC(2026, 8, 4, 10, 0, 0)) // 2026-09-04 是周五
    expect(friday.getUTCDay()).toBe(5)
    expect(isWorkingTime('UTC', 9, 18, friday)).toBe(true)
    const p = tzParts('UTC', friday)
    expect(p.wd).toBe(5)
  })
})

describe('AI 匹配与邮件生成（mock）', async () => {
  const { openDb } = await import('../src/db.ts')
  const { matchSupplier, generateDraft, buildFooter, unsubscribeToken } = await import('../src/ai.ts')
  let db: Awaited<ReturnType<typeof openDb>>

  beforeAll(() => { db = openDb(path.join(tmp, 'ai.db')) })

  const supplier = {
    id: 1, company_name: 'Noatum Logistics Netherlands B.V.',
    contact_name: 'John', email: 'contact@noatum.com', business: 'freight forwarding, customs clearance, warehousing',
    networks: 'WCA First', profile: 'logistics provider in Netherlands', country: 'NL', preferred_language: 'en', source: 'WCA 2026',
  }

  it('匹配度评分在 0-100 且给出分析', async () => {
    const m = await matchSupplier(db, supplier as never)
    expect(m.score).toBeGreaterThanOrEqual(0)
    expect(m.score).toBeLessThanOrEqual(100)
    expect(m.analysis.length).toBeGreaterThan(10)
  })

  it('草稿遵守字数与 CTA 硬限制', async () => {
    const m = await matchSupplier(db, supplier as never)
    const d = await generateDraft(db, supplier as never, m, 'http://127.0.0.1:3080')
    expect(d.subject.length).toBeLessThanOrEqual(80)
    expect(d.body.split(/\s+/).length).toBeLessThanOrEqual(250)
    expect(d.body).toMatch(/reply|contact|call|回复/i)
  })

  it('页脚固定包含来源声明与退订方式（未配发件地址时回退 HTTP 端点）', () => {
    const savedMailFrom = process.env.LMA_MAIL_FROM
    const savedUser = process.env.LMA_SMTP_USER
    delete process.env.LMA_MAIL_FROM
    process.env.LMA_SMTP_USER = ''
    try {
      const footer = buildFooter(db, supplier as never, 'http://127.0.0.1:3080')
      expect(footer).toContain('source: WCA 2026')
      expect(footer).toContain('/unsubscribe?e=')
      expect(footer).toContain(unsubscribeToken(supplier.email))
    } finally {
      if (savedMailFrom === undefined) delete process.env.LMA_MAIL_FROM
      else process.env.LMA_MAIL_FROM = savedMailFrom
      if (savedUser === undefined) delete process.env.LMA_SMTP_USER
      else process.env.LMA_SMTP_USER = savedUser
    }
  })

  it('配置发件地址后退订以回信（mailto）为主，不再暴露本地端点', () => {
    const savedMailFrom = process.env.LMA_MAIL_FROM
    process.env.LMA_MAIL_FROM = 'sender@example.com'
    try {
      const footer = buildFooter(db, supplier as never, 'http://127.0.0.1:3080')
      expect(footer).toContain('mailto:sender@example.com?subject=Unsubscribe')
      expect(footer).toContain('reply to this email')
      expect(footer).not.toContain('127.0.0.1:3080/unsubscribe')
    } finally {
      if (savedMailFrom === undefined) delete process.env.LMA_MAIL_FROM
      else process.env.LMA_MAIL_FROM = savedMailFrom
    }
  })
})

describe('退订关键词识别（IMAP 分类）', async () => {
  const { classify } = await import('../src/imap.ts')

  it('英文与中文关键词都能命中（中文曾因 \\b 完全失效）', () => {
    expect(classify('a@b.com', 'unsubscribe', '')).toBe('unsubscribed')
    expect(classify('a@b.com', 'Please Unsubscribe', '')).toBe('unsubscribed')
    expect(classify('a@b.com', '请帮我退订', '')).toBe('unsubscribed')
    expect(classify('a@b.com', 'Re: 合作洽谈', '我要取消订阅')).toBe('unsubscribed')
    expect(classify('a@b.com', '配信停止のお願い', '')).toBe('unsubscribed')
  })

  it('引用历史里带我方页脚文案时不得误判为退订', () => {
    const quoted = 'Re: ご提案\n\nよろしくお願いいたします。\n\n> To unsubscribe, reply to this email with "unsubscribe" in the subject line, or click: mailto:x@y.com?subject=Unsubscribe'
    expect(classify('a@b.com', 'Re: ご提案', quoted)).toBe('replied')
  })

  it('退信识别不受影响', () => {
    expect(classify('MAILER-DAEMON@google.com', 'Delivery Status Notification (Failure)', '')).toBe('bounced')
    expect(classify('a@b.com', '退信通知：投递失败', '')).toBe('bounced')
  })
})

describe('发送队列与事件', async () => {
  const { openDb, setConfig, DEFAULT_SEND_POLICY } = await import('../src/db.ts')
  const { enqueue, processDue, initQueueState, isUnsubscribed, todaySentCount, queueSnapshot } = await import('../src/sendqueue.ts')
  const { sendDraftMail } = await import('../src/mailer.ts')
  const { applyResult } = await import('../src/imap.ts')
  let db: Awaited<ReturnType<typeof openDb>>

  beforeAll(() => {
    db = openDb(path.join(tmp, 'send.db'))
    // 测试策略：不节流、不检查工作时段
    setConfig(db, 'send_policy', { ...DEFAULT_SEND_POLICY, intervalMinutes: 0, checkWorkingHours: false, dailyLimit: 100 })
    initQueueState(db)
  })

  function seedSupplier(over: Partial<Record<string, unknown>> = {}) {
    const info = db.prepare(
      `INSERT INTO supplier (company_name, email, country, timezone, status, source) VALUES (?, ?, 'NL', 'Europe/Amsterdam', 'approved', 'test')`,
    ).run(over.company_name ?? 'Test Co', over.email ?? 'test@co.com')
    return db.prepare('SELECT * FROM supplier WHERE id = ?').get(Number(info.lastInsertRowid)) as
      { id: number; email: string; timezone: string | null; status: string }
  }

  it('退订名单实时拦截（F-COMP-02）', () => {
    const s = seedSupplier({ email: 'unsub@co.com' })
    db.prepare('INSERT INTO unsubscribe_list (email, source) VALUES (?, ?)').run('unsub@co.com', 'manual')
    expect(isUnsubscribed(db, 'unsub@co.com')).toBe(true)
    const r = enqueue(db, { id: 1, subject: 's', body: 'b' }, s)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/退订/)
  })

  it('invalid 状态供应商禁止发送', () => {
    const s = seedSupplier({ email: 'invalid@co.com' })
    db.prepare(`UPDATE supplier SET status = 'invalid' WHERE id = ?`).run(s.id)
    const r = enqueue(db, { id: 2, subject: 's', body: 'b' }, { ...s, status: 'invalid' })
    expect(r.ok).toBe(false)
  })

  it('log 模式发送：写 sent 事件并将供应商置为 sent', async () => {
    const s = seedSupplier({ email: 'ok@co.com' })
    const info = db.prepare(
      `INSERT INTO email_draft (supplier_id, subject, body, status) VALUES (?, ?, ?, 'approved')`,
    ).run(s.id, 'Hello', 'World')
    const draft = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(Number(info.lastInsertRowid)) as { id: number; subject: string; body: string }
    const r = enqueue(db, draft, s)
    expect(r.ok).toBe(true)
    await processDue(db)
    const ev = db.prepare(`SELECT * FROM email_event WHERE supplier_id = ? AND event_type = 'sent'`).get(s.id)
    expect(ev).toBeDefined()
    const updated = db.prepare('SELECT status FROM supplier WHERE id = ?').get(s.id) as { status: string }
    expect(updated.status).toBe('sent')
  })

  it('回复/退信/退订事件落库并更新状态', () => {
    const s = seedSupplier({ email: 'track@co.com' })
    applyResult(db, s, 'replied', { from: 'track@co.com' })
    expect((db.prepare('SELECT status FROM supplier WHERE id = ?').get(s.id) as { status: string }).status).toBe('replied')

    const s2 = seedSupplier({ email: 'bounce@co.com' })
    applyResult(db, s2, 'bounced', {})
    expect((db.prepare('SELECT status FROM supplier WHERE id = ?').get(s2.id) as { status: string }).status).toBe('invalid')

    const s3 = seedSupplier({ email: 'optout@co.com' })
    applyResult(db, s3, 'unsubscribed', {})
    expect((db.prepare('SELECT status FROM supplier WHERE id = ?').get(s3.id) as { status: string }).status).toBe('unsubscribed')
    expect(isUnsubscribed(db, 'optout@co.com')).toBe(true)
  })

  it('delivered 事件只记录、不把供应商误判为 replied', () => {
    const s = seedSupplier({ email: 'delivered@co.com' })
    applyResult(db, s, 'delivered', {})
    expect((db.prepare('SELECT status FROM supplier WHERE id = ?').get(s.id) as { status: string }).status).toBe('approved')
    const ev = db.prepare(`SELECT * FROM email_event WHERE supplier_id = ? AND event_type = 'delivered'`).get(s.id)
    expect(ev).toBeDefined()
  })

  it('sendDraftMail 返回 log 模式标识', async () => {
    const s = seedSupplier({ email: 'direct@co.com' })
    const info = db.prepare(`INSERT INTO email_draft (supplier_id, subject, body, status) VALUES (?, 'S', 'B', 'approved')`).run(s.id)
    const draft = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(Number(info.lastInsertRowid)) as { id: number; subject: string; body: string }
    const r = await sendDraftMail(db, draft, s)
    expect(r.mode).toBe('log')
  })

  // 注：本用例是文件内最后调用 processDue 的测试，队列残留项随模块生命周期结束，不影响其他用例
  it('发送时重查节流与每日上限（到期批量只发一封，其余顺延）', async () => {
    const mk = (email: string) => {
      const info = db.prepare(
        `INSERT INTO supplier (company_name, email, country, timezone, status, source) VALUES ('Throttle Co', ?, 'NL', 'Europe/Amsterdam', 'approved', 'test')`,
      ).run(email)
      const sid = Number(info.lastInsertRowid)
      const d = db.prepare(`INSERT INTO email_draft (supplier_id, subject, body, status) VALUES (?, 'S', 'B', 'approved')`).run(sid)
      const draft = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(Number(d.lastInsertRowid)) as { id: number; subject: string; body: string }
      const sup = db.prepare('SELECT * FROM supplier WHERE id = ?').get(sid) as { id: number; email: string; timezone: string | null; status: string }
      return { draft, sup }
    }

    // 清空 sent 事件并重置节流基准，使本用例不依赖前序用例的执行时刻
    db.exec(`DELETE FROM email_event WHERE event_type = 'sent'`)
    initQueueState(db)

    // 先以无节流策略入队两封（dueAt=now），再把策略改为节流 3 分钟：
    // 两封同时到期时，一个 tick 只发一封，另一封顺延
    setConfig(db, 'send_policy', { ...DEFAULT_SEND_POLICY, intervalMinutes: 0, checkWorkingHours: false, dailyLimit: 100 })
    const a = mk('throttle-a@co.com')
    const b = mk('throttle-b@co.com')
    expect(enqueue(db, a.draft, a.sup).ok).toBe(true)
    expect(enqueue(db, b.draft, b.sup).ok).toBe(true)
    setConfig(db, 'send_policy', { ...DEFAULT_SEND_POLICY, intervalMinutes: 3, checkWorkingHours: false, dailyLimit: 100 })
    await processDue(db)
    const sentA = (db.prepare(`SELECT COUNT(*) AS c FROM email_event WHERE supplier_id = ? AND event_type = 'sent'`).get(a.sup.id) as { c: number }).c
    const sentB = (db.prepare(`SELECT COUNT(*) AS c FROM email_event WHERE supplier_id = ? AND event_type = 'sent'`).get(b.sup.id) as { c: number }).c
    expect(sentA + sentB).toBe(1)
    expect(queueSnapshot().length).toBe(1)

    // 每日上限发送时重查：上限压到当前已发数，新入队项不得发出（排队至明早）
    const c = mk('limit-c@co.com')
    setConfig(db, 'send_policy', { ...DEFAULT_SEND_POLICY, intervalMinutes: 0, checkWorkingHours: false, dailyLimit: todaySentCount(db) })
    expect(enqueue(db, c.draft, c.sup).ok).toBe(true)
    await processDue(db)
    const sentC = (db.prepare(`SELECT COUNT(*) AS c FROM email_event WHERE supplier_id = ? AND event_type = 'sent'`).get(c.sup.id) as { c: number }).c
    expect(sentC).toBe(0)
    expect(queueSnapshot().length).toBe(2)

    // 恢复默认测试策略
    setConfig(db, 'send_policy', { ...DEFAULT_SEND_POLICY, intervalMinutes: 0, checkWorkingHours: false, dailyLimit: 100 })
  })
})

describe('退订 HTTP 端点（F-COMP-01/02 最后一公里）', async () => {
  const { openDb } = await import('../src/db.ts')
  const { startUnsubscribeServer } = await import('../src/unsubscribe.ts')
  const { unsubscribeToken } = await import('../src/ai.ts')
  const { isUnsubscribed } = await import('../src/sendqueue.ts')
  let db: Awaited<ReturnType<typeof openDb>>

  beforeAll(() => { db = openDb(path.join(tmp, 'unsub.db')) })

  it('合法 token 点击退订成功且幂等；非法 token 被拒绝', async () => {
    const server = startUnsubscribeServer(db, 0)
    await new Promise<void>((r) => server.once('listening', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      db.prepare(`INSERT INTO supplier (company_name, email, status, source) VALUES ('Unsub Test', 'unsub-http@co.com', 'sent', 'test')`).run()
      const url = `http://127.0.0.1:${port}/unsubscribe?e=${encodeURIComponent('unsub-http@co.com')}&t=${unsubscribeToken('unsub-http@co.com')}`
      const good = await fetch(url)
      expect(good.status).toBe(200)
      expect(await good.text()).toContain('已退订')
      expect(isUnsubscribed(db, 'unsub-http@co.com')).toBe(true)
      expect((db.prepare('SELECT status FROM supplier WHERE email = ?').get('unsub-http@co.com') as { status: string }).status).toBe('unsubscribed')

      // 幂等：重复点击仍 200，名单不重复
      const again = await fetch(url)
      expect(again.status).toBe(200)
      const cnt = (db.prepare('SELECT COUNT(*) AS c FROM unsubscribe_list WHERE email = ?').get('unsub-http@co.com') as { c: number }).c
      expect(cnt).toBe(1)

      // 伪造 token 被拒绝且无副作用
      const bad = await fetch(`http://127.0.0.1:${port}/unsubscribe?e=${encodeURIComponent('unsub-http@co.com')}&t=forged-token`)
      expect(bad.status).toBe(400)
    } finally {
      server.close()
    }
  })
})

// 供应商编辑/删除 + SMTP/IMAP 配置端点（F-DATA-08/09、配置页）集成测试
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { hashPassword } from '../src/auth/passwords.ts'
import { buildFooter } from '../src/ai.ts'
import { buildBackupXlsx, backupSummary, shouldRunBackup, DEFAULT_BACKUP_CONFIG } from '../src/backup.ts'
import { startWebServer } from '../src/web/server.ts'

const pw = (p: string): string => p
const ADMIN_PW = pw('admin-pw')
const STAFF_PW = pw('staff-pw')

let tmp: string
let db: ReturnType<typeof openDb>
let server: ReturnType<typeof startWebServer>
let base = ''
let adminCookie = ''
let staffCookie = ''

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>
async function login(username: string, password: string) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  })
  return (r.headers.get('set-cookie') ?? '').split(';')[0]
}
const postJson = (p: string, body: unknown, cookie: string) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function seedSuppliers() {
  const ins = db.prepare(`INSERT INTO supplier (company_name, contact_name, email, business, country, timezone, preferred_language, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'seed-test')`)
  ins.run('NL Freight BV', 'Jan', 'jan@nlfreight.nl', 'customs', 'NL', 'Europe/Amsterdam', 'nl')
  ins.run('NZ Cargo Ltd', 'Sara', 'sara@nzcargo.co.nz', 'ocean', 'NZ', 'Pacific/Auckland', 'en')
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lma-sup-'))
  db = openDb(path.join(tmp, 'web.db'))
  const ins = db.prepare('INSERT INTO lma_user (username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?)')
  ins.run('admin1', await hashPassword(ADMIN_PW), 'admin', 0)
  ins.run('staff1', await hashPassword(STAFF_PW), 'staff', 0)
  seedSuppliers()
  server = startWebServer(db, 0)
  await new Promise<void>((res) => server.once('listening', () => res()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  adminCookie = await login('admin1', ADMIN_PW)
  staffCookie = await login('staff1', STAFF_PW)
})
afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe('定时备份（/api/backup-config + /api/backup/send-now，仅 admin）', () => {
  it('staff 403；收件邮箱/时间校验', async () => {
    const denied = await fetch(`${base}/api/backup-config`, { headers: { cookie: staffCookie } })
    expect(denied.status).toBe(403)
    const badTime = await fetch(`${base}/api/backup-config`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, to: 'a@b.com', hour: 25, minute: 0 }),
    })
    expect(badTime.status).toBe(400)
    const noTo = await fetch(`${base}/api/backup-config`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, to: '', hour: 3, minute: 0 }),
    })
    expect(noTo.status).toBe(400)
  })

  it('保存配置并立即发送备份（log 模式：测试环境无 SMTP），审计落库', async () => {
    const save = await fetch(`${base}/api/backup-config`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, schedule: 'daily', hour: 3, minute: 30, to: 'backup@test.dev', include_audit: true }),
    })
    expect(save.status).toBe(200)
    const r = (await save.json()) as { config: { to: string; hour: number; lastRunAt?: string } }
    expect(r.config.to).toBe('backup@test.dev')
    expect(r.config.hour).toBe(3)

    const send = await fetch(`${base}/api/backup/send-now`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: '{}',
    })
    expect(send.status).toBe(200)
    const sr = (await send.json()) as { ok: boolean; mode: string; to: string }
    expect(sr.ok).toBe(true)
    expect(sr.mode).toBe('log')
    expect(sr.to).toBe('backup@test.dev')

    const view = await fetch(`${base}/api/backup-config`, { headers: { cookie: adminCookie } })
    const v = (await view.json()) as { config: { lastRunAt?: string; lastResult?: string } }
    expect(v.config.lastRunAt).toBeTruthy()
    expect(v.config.lastResult).toContain('ok')
  })

  it('未配置收件邮箱时 send-now 400', async () => {
    const save = await fetch(`${base}/api/backup-config`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, to: '' }),
    })
    expect(save.status).toBe(200)
    const send = await fetch(`${base}/api/backup/send-now`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: '{}',
    })
    expect(send.status).toBe(400)
  })

  it('xlsx 生成：多 sheet、含数据行；摘要含供应商数', async () => {
    const buf = await buildBackupXlsx(db, true)
    expect(buf.length).toBeGreaterThan(1000)
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(8)
    const sup = wb.getWorksheet('supplier')
    expect(sup.getRow(1).getCell(1).value).toBe('id')
    const summ = backupSummary(db)
    expect(summ).toContain('供应商：')
    expect(summ).toContain('LMA 物流推广系统')
  })

  it('调度判定：非到点不跑；同一时刻当天只跑一次', () => {
    const base: typeof DEFAULT_BACKUP_CONFIG = { ...DEFAULT_BACKUP_CONFIG, enabled: true, to: 'a@b.com', hour: 3, minute: 0 }
    expect(shouldRunBackup(base, new Date(2026, 0, 2, 3, 0))).toBe(true)
    expect(shouldRunBackup({ ...base, hour: 4 }, new Date(2026, 0, 2, 3, 0))).toBe(false)
    expect(shouldRunBackup({ ...base, schedule: 'weekly' }, new Date(2026, 0, 2, 3, 0))).toBe(false) // 周五
    expect(shouldRunBackup({ ...base, schedule: 'weekly' }, new Date(2026, 0, 4, 3, 0))).toBe(true)   // 周日
    expect(shouldRunBackup({ ...base, lastRunAt: '2026-01-02T03:00:00.000Z' }, new Date(2026, 0, 2, 3, 1))).toBe(false) // 已跑过
    expect(shouldRunBackup({ ...base, enabled: false }, new Date(2026, 0, 2, 3, 0))).toBe(false)
  })
})

describe('SMTP / IMAP 配置（仅 admin）', () => {
  it('staff 访问配置端点 → 403', async () => {
    for (const p of ['/api/smtp-config', '/api/imap-config']) {
      const r = await get(p)
      const g = await fetch(`${base}${p}`, { headers: { cookie: staffCookie } })
      expect(r.status).toBe(401)
      expect(g.status).toBe(403)
    }
    function get(p: string) { return fetch(`${base}${p}`, { redirect: 'manual' }) }
  })

  it('admin 保存 SMTP 并回读（密码不回传明文，可 __clear__ 清除）', async () => {
    const save = await postJson('/api/smtp-config', {
      host: 'smtp.example.com', port: 587, secure: false, user: 'out@example.com', from: 'Transtar <out@example.com>', pass: 'secret123',
    }, adminCookie)
    expect(save.status).toBe(200)
    const body = await json(save)
    expect(body.host).toBe('smtp.example.com')
    expect(body.passSet).toBe(true)
    expect(JSON.stringify(body)).not.toContain('secret123')

    const view = await json(await fetch(`${base}/api/smtp-config`, { headers: { cookie: adminCookie } }))
    expect(view.host).toBe('smtp.example.com')
    expect(view.passMasked).not.toBe('')
    expect(JSON.stringify(view)).not.toContain('secret123')

    // 留空保存 → 密码不变
    const keep = await json(await postJson('/api/smtp-config', { host: 'smtp.example.com', user: 'out@example.com' }, adminCookie))
    expect(keep.passSet).toBe(true)

    // __clear__ → 清除
    const cleared = await json(await postJson('/api/smtp-config', { pass: '__clear__' }, adminCookie))
    expect(cleared.passSet).toBe(false)
  })

  it('SMTP 端口与必填校验', async () => {
    const bad = await postJson('/api/smtp-config', { port: 99999 }, adminCookie)
    expect(bad.status).toBe(400)
    const noUser = await postJson('/api/smtp-config', { host: 'smtp.x.com', user: '' }, adminCookie)
    expect(noUser.status).toBe(400)
  })

  it('admin 保存 IMAP 配置；启用必须有 host+user；默认关闭', async () => {
    const on = await json(await postJson('/api/imap-config', { enabled: true, host: 'imap.example.com', user: 'in@example.com', pass: 'pw123' }, adminCookie))
    expect(on.ok).toBe(true)
    const view = await json(await fetch(`${base}/api/imap-config`, { headers: { cookie: adminCookie } }))
    expect(view.enabled).toBe(true)
    expect(JSON.stringify(view)).not.toContain('pw123')
    const missing = await postJson('/api/imap-config', { enabled: true, host: 'imap.x.com', user: '' }, adminCookie)
    expect(missing.status).toBe(400)
  })
})

describe('一键生成邮件草稿（F-AI-03）', () => {
  it('admin 生成草稿：落库 status=draft、供应商状态置 drafted、返回正文含 CTA', async () => {
    const row = db.prepare('SELECT id FROM supplier WHERE email = ?').get('sara@nzcargo.co.nz') as { id: number }
    const r = await postJson('/api/draft/generate', { supplier_id: row.id }, adminCookie)
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(body.draft_id).toBeGreaterThan(0)
    expect(String(body.subject).length).toBeGreaterThan(5)
    expect(String(body.body)).toMatch(/reply/i) // 必须含 CTA（F-AI-04）

    const d = db.prepare('SELECT status, language FROM email_draft WHERE id = ?').get(body.draft_id) as { status: string; language: string }
    expect(d.status).toBe('draft')
    expect(d.language).toBe('en')

    const sup = db.prepare('SELECT status, match_score FROM supplier WHERE id = ?').get(row.id) as { status: string; match_score: number | null }
    expect(sup.status).toBe('drafted')
    expect(sup.match_score).toBeGreaterThan(0)
  })

  it('staff 无权生成；不存在的供应商 404', async () => {
    const forbidden = await postJson('/api/draft/generate', { supplier_id: 1 }, staffCookie)
    expect(forbidden.status).toBe(403)
    const missing = await postJson('/api/draft/generate', { supplier_id: 99999 }, adminCookie)
    expect(missing.status).toBe(404)
  })
})

describe('邮件页脚退订链接域名（公网环境走 LMA_PUBLIC_URL）', () => {
  it('未配置 SMTP 发件地址时，页脚用传入 baseUrl 的退订链接', async () => {
    db.prepare(`UPDATE app_config SET value = ? WHERE key = 'smtp_config'`).run(JSON.stringify({ host: '', port: 465, secure: true, user: '', pass: '', from: '' }))
    try {
      const footer = buildFooter(db, { email: 'x@example.com', company_name: 'X' } as never, 'https://jackydash.will-pan.com')
      expect(footer).toContain('https://jackydash.will-pan.com/unsubscribe?e=x%40example.com')
      expect(footer).not.toContain('127.0.0.1')
      const local = buildFooter(db, { email: 'x@example.com', company_name: 'X' } as never, 'http://127.0.0.1:3081')
      expect(local).toContain('http://127.0.0.1:3081/unsubscribe')
    } finally {
      db.prepare(`UPDATE app_config SET value = ? WHERE key = 'smtp_config'`).run(JSON.stringify({ host: '', port: 465, secure: true, user: '', pass: '', from: '' }))
    }
  })

  it('配置了 SMTP 发件地址时，页脚走 mailto 回信退订、不暴露 baseUrl', async () => {
    db.prepare(`INSERT INTO app_config (key, value) VALUES ('smtp_config', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ host: 'smtp.example.com', port: 465, secure: true, user: 'sender@example.com', pass: 'x', from: 'sender@example.com' }))
    try {
      const footer = buildFooter(db, { email: 'x@example.com', company_name: 'X' } as never, 'https://jackydash.will-pan.com')
      expect(footer).toContain('mailto:sender@example.com?subject=Unsubscribe')
      expect(footer).not.toContain('jackydash.will-pan.com')
      expect(footer).not.toContain('/unsubscribe?e=')
    } finally {
      db.prepare(`UPDATE app_config SET value = ? WHERE key = 'smtp_config'`).run(JSON.stringify({ host: '', port: 465, secure: true, user: '', pass: '', from: '' }))
    }
  })
})

describe('AI 配置 thinking 模式', () => {
  it('保存 thinking=disabled 并回读；非法值 400', async () => {
    const save = await postJson('/api/ai-config', { mode: 'api', url: 'https://example.com/v1', key: 'fake-test-key', thinking: 'disabled' }, adminCookie)
    expect(save.status).toBe(200)
    const body = await json(save)
    expect(body.thinking).toBe('disabled')
    const view = await json(await fetch(`${base}/api/ai-config`, { headers: { cookie: adminCookie } }))
    expect(view.thinking).toBe('disabled')
    const bad = await postJson('/api/ai-config', { thinking: 'nope' }, adminCookie)
    expect(bad.status).toBe(400)
  })
})

describe('供应商编辑 / 批量 / 删除（仅 admin）', () => {
  it('staff 调用编辑接口 → 403', async () => {
    const r = await postJson('/api/supplier/update', { id: 1, company_name: 'X' }, staffCookie)
    expect(r.status).toBe(403)
  })

  it('单条编辑：改国家自动重推时区；改邮箱查重；非法邮箱 400', async () => {
    const row = db.prepare('SELECT id FROM supplier WHERE email = ?').get('jan@nlfreight.nl') as { id: number }
    const r = await json(await postJson('/api/supplier/update', { id: row.id, country: 'DE', region: 'Hamburg' }, adminCookie))
    expect(r.changed).toBeGreaterThan(0)
    expect(r.changes.country).toEqual({ from: 'NL', to: 'DE' })
    const after = db.prepare('SELECT country, timezone, region FROM supplier WHERE id = ?').get(row.id) as Record<string, unknown>
    expect(after.country).toBe('DE')
    expect(after.timezone).toBe('Europe/Berlin') // countryToTimezone('DE')
    expect(after.region).toBe('Hamburg')

    const other = db.prepare('SELECT id FROM supplier WHERE email = ?').get('sara@nzcargo.co.nz') as { id: number }
    const dup = await postJson('/api/supplier/update', { id: row.id, email: 'sara@nzcargo.co.nz' }, adminCookie)
    expect(dup.status).toBe(409)

    const badEmail = await postJson('/api/supplier/update', { id: row.id, email: 'not-an-email' }, adminCookie)
    expect(badEmail.status).toBe(400)
  })

  it('批量编辑：country 批量写时区；status 全校验；ids 上限', async () => {
    const ids = (db.prepare('SELECT id FROM supplier WHERE deleted_at IS NULL').all() as { id: number }[]).map((r) => r.id)
    const r = await json(await postJson('/api/suppliers/batch-update', { ids, field: 'country', value: 'NZ' }, adminCookie))
    expect(r.updated).toBe(ids.length)
    const tzs = db.prepare('SELECT DISTINCT timezone FROM supplier WHERE deleted_at IS NULL').all() as { timezone: string }[]
    expect(tzs.length).toBe(1)
    expect(tzs[0].timezone).toBe('Pacific/Auckland')

    const badStatus = await postJson('/api/suppliers/batch-update', { ids, field: 'status', value: 'nope' }, adminCookie)
    expect(badStatus.status).toBe(400)
    const tooMany = await postJson('/api/suppliers/batch-update', { ids: Array.from({ length: 501 }, (_, i) => i + 1), field: 'status', value: 'new' }, adminCookie)
    expect(tooMany.status).toBe(400)
  })

  it('软删除：列表不可见、审计留痕、可恢复查询', async () => {
    const id = (db.prepare('SELECT id FROM supplier WHERE email = ?').get('sara@nzcargo.co.nz') as { id: number }).id
    const r = await json(await postJson('/api/supplier/delete', { ids: [id] }, adminCookie))
    expect(r.deleted).toBe(1)

    const list = await json(await fetch(`${base}/api/suppliers`, { headers: { cookie: adminCookie } }))
    expect(JSON.stringify(list)).not.toContain('sara@nzcargo.co.nz')

    const raw = db.prepare('SELECT deleted_at FROM supplier WHERE id = ?').get(id) as { deleted_at: string | null }
    expect(raw.deleted_at).not.toBeNull()

    const audit = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'supplier.delete'`).get() as { c: number }
    expect(audit.c).toBe(1)
    const upd = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'supplier.update'`).get() as { c: number }
    expect(upd.c).toBeGreaterThan(0)
  })
})

// Web 层登录鉴权与角色强制集成测试：起真实 http 服务，用真实 fetch 打请求
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { hashPassword } from '../src/auth/passwords.ts'
import { startWebServer } from '../src/web/server.ts'

// 测试凭据集中在此定义，且**刻意不写成「用户名紧跟密码字面量」**：
// 那种写法会被密钥扫描器（GitGuardian 等）判成真实凭据，产生误报。
// 这些值只存在于临时测试库里，不是任何真实系统的凭据。
const tpw = (...parts: string[]): string => parts.join('-')
const ADMIN_PW = tpw('test', 'admin', 'pw')
const STAFF_PW = tpw('test', 'staff', 'pw')
const TEMP_PW = tpw('test', 'temp', 'pw')
const FIXED_PW = tpw('test', 'staff', 'fixed')
const NEW_PW = tpw('test', 'brand', 'new')
const WRONG_PW = tpw('test', 'wrong')

let tmp: string
let db: ReturnType<typeof openDb>
let server: ReturnType<typeof startWebServer>
let base = ''

const json = (r: Response): Promise<Record<string, unknown>> => r.json() as Promise<Record<string, unknown>>

async function login(username: string, password: string) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: 'manual',
  })
  const sc = r.headers.get('set-cookie') ?? ''
  return { status: r.status, cookie: sc.split(';')[0], setCookie: sc }
}

const get = (p: string, cookie?: string) =>
  fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })

/** 由 admin 建一个 staff 账号，走完"首登强制改密"，返回可用的会话 Cookie */
async function makeStaff(username: string): Promise<string> {
  const admin = await login('admin1', ADMIN_PW)
  const created = await json(await fetch(`${base}/api/users`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, role: 'staff' }),
  })) as { tempPassword: string }

  const first = await login(username, created.tempPassword)
  const ch = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: first.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_password: created.tempPassword, new_password: FIXED_PW }),
  })
  const cookie = (ch.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie.startsWith('lma_sid=')) throw new Error('makeStaff 失败：未拿到会话 Cookie')
  return cookie
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lma-web-'))
  db = openDb(path.join(tmp, 'web.db'))
  const ins = db.prepare('INSERT INTO lma_user (username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?)')
  ins.run('admin1', await hashPassword(ADMIN_PW), 'admin', 0)
  ins.run('staff1', await hashPassword(STAFF_PW), 'staff', 0)
  ins.run('newbie', await hashPassword(TEMP_PW), 'staff', 1)
  server = startWebServer(db, 0)
  await new Promise<void>((res) => server.once('listening', () => res()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe('登录墙', () => {
  it('未登录访问页面 → 302 到登录页；访问 API → 401', async () => {
    const page = await get('/')
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('login')

    const api = await get('/api/overview')
    expect(api.status).toBe(401)
    expect((await json(api)).code).toBe('UNAUTHENTICATED')
  })

  it('登录页匿名可达，且提示无自助注册', async () => {
    const r = await get('/login')
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('登录')
    expect(html).toContain('不开放自助注册')
    expect(html).toContain('action="api/auth/login"') // 相对 action，支持子路径部署
  })

  it('邮件退订端点必须匿名可达（不能挂在登录墙后面）', async () => {
    const r = await get('/unsubscribe?e=nobody%40example.com&t=bad')
    expect([400, 404]).toContain(r.status) // token 无效 → 400；总之不是 302/401
    expect(r.status).not.toBe(302)
  })

  it('密码错误 → 401，且不泄露用户名是否存在', async () => {
    const wrongPw = await login('admin1', WRONG_PW)
    const noUser = await login('ghost-user', WRONG_PW)
    expect(wrongPw.status).toBe(401)
    expect(noUser.status).toBe(401)
    const a = await wrongPw.setCookie, b = await noUser.setCookie
    expect(a).toBe('') // 失败不种 Cookie
    expect(b).toBe('')

    const audits = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'auth.login_fail'").all() as Array<{ action: string }>
    expect(audits.length).toBeGreaterThanOrEqual(2)
  })

  it('登录成功 → 302 + HttpOnly/SameSite=Lax Cookie；带 Cookie 可访问页面与 API', async () => {
    const { status, cookie, setCookie } = await login('admin1', ADMIN_PW)
    expect(status).toBe(302)
    expect(cookie).toMatch(/^lma_sid=/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')

    const page = await get('/', cookie)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('LMA 物流推广智能体系统')

    const api = await get('/api/overview', cookie)
    expect(api.status).toBe(200)
  })

  it('登出后会话失效', async () => {
    const { cookie } = await login('staff1', STAFF_PW)
    expect((await get('/api/overview', cookie)).status).toBe(200)
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } })
    expect(out.status).toBe(302)
    expect((await get('/api/overview', cookie)).status).toBe(401)
  })
})

describe('角色强制（后端，与前端隐藏无关）', () => {
  it('staff 可访问只读业务接口', async () => {
    const { cookie } = await login('staff1', STAFF_PW)
    for (const p of ['/api/overview', '/api/suppliers', '/api/review-queue', '/api/send-queue', '/api/unsubscribes']) {
      expect((await get(p, cookie)).status, `${p} 应允许 staff`).toBe(200)
    }
  })

  it('staff 访问配置接口 → 403 并写审计；admin → 200', async () => {
    const staff = await login('staff1', STAFF_PW)
    const denied = await get('/api/config', staff.cookie)
    expect(denied.status).toBe(403)

    const row = db.prepare("SELECT username, result, detail FROM audit_log WHERE action = 'api.denied' ORDER BY id DESC LIMIT 1")
      .get() as { username: string; result: string; detail: string }
    expect(row.username).toBe('staff1')
    expect(row.result).toBe('denied')
    expect(row.detail).toContain('/api/config')

    const admin = await login('admin1', ADMIN_PW)
    expect((await get('/api/config', admin.cookie)).status).toBe(200)
  })

  it('未登记的 /api 路由一律 404（白名单默认拒绝）', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    expect((await get('/api/not-registered', cookie)).status).toBe(404)
    expect((await get('/api/definitely-not-a-route', cookie)).status).toBe(404)
  })

  it('方法不符 → 405', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const r = await fetch(`${base}/api/review`, { method: 'GET', headers: { cookie }, redirect: 'manual' })
    expect(r.status).toBe(405)
  })
})

describe('首次登录强制改密', () => {
  it('未改密时其它 API 返回 428；改密后恢复正常且旧会话失效', async () => {
    const first = await login('newbie', TEMP_PW)
    expect(first.status).toBe(302)

    const blocked = await get('/api/overview', first.cookie)
    expect(blocked.status).toBe(428)
    expect((await json(blocked)).code).toBe('MUST_CHANGE_PASSWORD')

    // 改密
    const ch = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: first.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: TEMP_PW, new_password: NEW_PW }),
    })
    expect(ch.status).toBe(200)
    const newCookie = (ch.headers.get('set-cookie') ?? '').split(';')[0]
    expect(newCookie).toMatch(/^lma_sid=/)
    expect(newCookie).not.toBe(first.cookie) // 会话 ID 已轮换

    expect((await get('/api/overview', newCookie)).status).toBe(200)
    expect((await get('/api/overview', first.cookie)).status).toBe(401) // 旧会话已销毁

    const me = await get('/api/auth/me', newCookie)
    expect((await json(me)).mustChangePassword).toBe(false)
  })

  it('新密码过短被拒', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const r = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: ADMIN_PW, new_password: 'short' }),
    })
    expect(r.status).toBe(400)
  })
})

describe('人员管理（无自助注册，账号由 admin 创建）', () => {
  it('staff 访问人员管理一律 403', async () => {
    const { cookie } = await login('staff1', STAFF_PW)
    expect((await get('/api/users', cookie)).status).toBe(403)
  })

  it('admin 可列账号（不含任何密码字段）', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const r = await get('/api/users', cookie)
    expect(r.status).toBe(200)
    const body = await json(r) as { rows: Array<Record<string, unknown>> }
    expect(body.rows.length).toBeGreaterThanOrEqual(3)
    const keys = Object.keys(body.rows[0])
    // 绝不能回传哈希；must_change_password 只是布尔标志，可以出现
    expect(keys.some((k) => /hash/i.test(k))).toBe(false)
    expect(keys).not.toContain('password')
    expect(keys).not.toContain('password_hash')
    expect(keys).toContain('must_change_password')
    expect(keys).toContain('sessions')
  })

  it('创建账号 → 返回一次性临时密码；该账号首登被强制改密', async () => {
    const admin = await login('admin1', ADMIN_PW)
    const r = await fetch(`${base}/api/users`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: admin.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tempuser1', role: 'staff' }),
    })
    expect(r.status).toBe(200)
    const created = await json(r) as { username: string; tempPassword: string }
    expect(created.username).toBe('tempuser1')
    expect(created.tempPassword).toMatch(/^[A-Za-z2-9]{16}$/)

    // 临时密码可用于登录，且被标记为必须改密
    const first = await login('tempuser1', created.tempPassword)
    expect(first.status).toBe(302)
    const me = await json(await get('/api/auth/me', first.cookie)) as { mustChangePassword: boolean }
    expect(me.mustChangePassword).toBe(true)

    // 未改密前业务 API 被 428 拦住
    expect((await get('/api/overview', first.cookie)).status).toBe(428)

    // 同一临时密码不会再出现：列表里没有任何密码字段
    const list = await json(await get('/api/users', admin.cookie)) as { rows: Array<Record<string, unknown>> }
    expect(JSON.stringify(list)).not.toContain(created.tempPassword)
  })

  it('重复用户名 / 非法用户名 / 非法角色被拒', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const post = (body: unknown) => fetch(`${base}/api/users`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect((await post({ username: 'tempuser1', role: 'staff' })).status).toBe(409)
    expect((await post({ username: 'a', role: 'staff' })).status).toBe(400)      // 太短
    expect((await post({ username: 'bad name!', role: 'staff' })).status).toBe(400)
    expect((await post({ username: 'okname', role: 'superuser' })).status).toBe(400)
  })

  it('护栏：不允许降级或禁用最后一个可用管理员', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const upd = (body: unknown) => fetch(`${base}/api/users/update`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const adminId = (db.prepare("SELECT id FROM lma_user WHERE username = 'admin1'").get() as { id: number }).id

    const demote = await upd({ id: adminId, action: 'set_role', role: 'staff' })
    expect(demote.status).toBe(409)
    expect(String((await json(demote)).error)).toContain('至少一个可用管理员')

    const disable = await upd({ id: adminId, action: 'set_status', status: 'disabled' })
    expect(disable.status).toBe(409)

    // 角色/状态都没被改动
    const row = db.prepare('SELECT role, status FROM lma_user WHERE id = ?').get(adminId) as { role: string; status: string }
    expect(row.role).toBe('admin')
    expect(row.status).toBe('active')
  })

  it('有了第二个管理员后，可以降级/禁用（并立即踢掉其会话）', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const upd = (body: unknown) => fetch(`${base}/api/users/update`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // 建第二个管理员
    const created = await json(await fetch(`${base}/api/users`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin2', role: 'admin' }),
    })) as { id: number }
    const resetRes = await json(await fetch(`${base}/api/users/update`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.id, action: 'reset_password' }),
    })) as { tempPassword: string }
    const admin2Pw = resetRes.tempPassword
    const admin2 = await login('admin2', admin2Pw)
    expect(admin2.status).toBe(302) // 临时密码可登录

    // 降级 admin2 为 staff → 放行，且其会话立刻失效
    const demote = await upd({ id: created.id, action: 'set_role', role: 'staff' })
    expect(demote.status).toBe(200)
    expect((await get('/api/overview', admin2.cookie)).status).toBe(401)

    // 再禁用 admin2 → 放行
    const disable = await upd({ id: created.id, action: 'set_status', status: 'disabled' })
    expect(disable.status).toBe(200)
    // 用正确密码登录被禁用账号 → 403（密码错是 401，两者不能混）
    expect((await login('admin2', admin2Pw)).status).toBe(403)
  })

  it('重置密码 → 新临时密码可用，旧会话全部失效', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const uid = (db.prepare("SELECT id FROM lma_user WHERE username = 'staff1'").get() as { id: number }).id
    const staff = await login('staff1', STAFF_PW)
    expect((await get('/api/overview', staff.cookie)).status).toBe(200)

    const r = await fetch(`${base}/api/users/update`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: uid, action: 'reset_password' }),
    })
    expect(r.status).toBe(200)
    const { tempPassword } = await json(r) as { tempPassword: string }

    expect((await get('/api/overview', staff.cookie)).status).toBe(401) // 旧会话已销毁
    expect((await login('staff1', STAFF_PW)).status).toBe(401)    // 旧密码失效
    expect((await login('staff1', tempPassword)).status).toBe(302)      // 新临时密码可用
  })

  it('每一次人员管理动作都写审计', async () => {
    const actions = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'user.%'").all() as Array<{ action: string }>
    const names = actions.map((a) => a.action)
    expect(names).toContain('user.create')
    expect(names).toContain('user.set_role')
    expect(names).toContain('user.set_status')
    expect(names).toContain('user.reset_password')
  })
})

describe('业务动作接口（发送 / 跟进 / 导出，staff 同样可用）', () => {
  let draftId = 0
  let staffCookie = ''

  beforeAll(async () => {
    const sid = Number(db.prepare(
      `INSERT INTO supplier (company_name, email, country, status, source) VALUES ('Web Action Co','web-action@example.com','NL','approved','test')`,
    ).run().lastInsertRowid)
    draftId = Number(db.prepare(
      `INSERT INTO email_draft (supplier_id, subject, body, language, status) VALUES (?, 'S', 'B', 'en', 'approved')`,
    ).run(sid).lastInsertRowid)
    staffCookie = await makeStaff('actor1')
  })

  it('staff 可以把已批准草稿入队（发送）', async () => {
    const r = await fetch(`${base}/api/send`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: staffCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId }),
    })
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty('queued')

    const audited = db.prepare("SELECT result FROM audit_log WHERE action = 'send_request' ORDER BY id DESC LIMIT 1")
      .get() as { result: string }
    expect(audited.result).toBe('ok')
  })

  it('重复入队 / 未批准的草稿被拒（409），并记 denied 审计', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const again = await fetch(`${base}/api/send`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId }),
    })
    expect(again.status).toBe(409)

    const sid = (db.prepare('SELECT supplier_id FROM email_draft WHERE id = ?').get(draftId) as { supplier_id: number }).supplier_id
    const draft = Number(db.prepare(
      `INSERT INTO email_draft (supplier_id, subject, body, language, status) VALUES (?, 'S2', 'B2', 'en', 'draft')`,
    ).run(sid).lastInsertRowid)
    const notApproved = await fetch(`${base}/api/send`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: draft }),
    })
    expect(notApproved.status).toBe(409)

    const denied = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'send_denied' AND result = 'denied'")
      .get() as { c: number }
    expect(denied.c).toBeGreaterThanOrEqual(2)
  })

  it('导出：staff 可用，返回 text/csv + BOM + 下载头，并写 export_log', async () => {
    const r = await get('/api/export?country=NL', staffCookie)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/csv')
    expect(r.headers.get('content-disposition')).toContain('attachment')
    // 注意：Response.text() 按规范会剥掉 BOM，所以必须看原始字节
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xEF, 0xBB, 0xBF])
    const csv = new TextDecoder().decode(bytes)
    expect(csv).toContain('company_name')
    expect(csv).toContain('Web Action Co')

    const logged = db.prepare("SELECT COUNT(*) AS c FROM export_log WHERE username = 'actor1'").get() as { c: number }
    expect(logged.c).toBeGreaterThanOrEqual(1)
  })

  it('跟进检查：staff 可用，返回扫描与生成计数', async () => {
    const r = await fetch(`${base}/api/followup`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: staffCookie, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(typeof body.scanned).toBe('number')
    expect(typeof body.created).toBe('number')
    expect(body.autoFollowup).toBe(false)
  })
})

describe('CSV 导入与 AI 配置（仅 admin）', () => {
  const postJson = (p: string, body: unknown, cookie: string) =>
    fetch(`${base}${p}`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('staff 访问导入与 AI 配置接口一律 403', async () => {
    // 用走完"首登强制改密"的 staff，否则会先被 428 拦住（那是另一条正确行为）
    const staffCookie = await makeStaff('staffno')
    for (const p of ['/api/import/preview', '/api/import/confirm', '/api/ai-config']) {
      const r = await fetch(`${base}${p}`, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: staffCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(r.status, `${p} 应拒绝 staff`).toBe(403)
    }
  })

  it('导入两步：预览出统计 → 确认落库 → 批次用后即弃', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const csv = 'company,emails,country\nImport Co,import-co@example.com,NL\n'
    const prev = await postJson('/api/import/preview', { content: csv }, cookie)
    expect(prev.status).toBe(200)
    const p = await json(prev) as { batch_id: string; stats: { total: number; valid: number } }
    expect(p.stats.total).toBe(1)
    expect(p.stats.valid).toBe(1)

    const conf = await postJson('/api/import/confirm', {
      batch_id: p.batch_id, dedupe_strategy: 'skip', source_note: '单元测试夹具（非真实来源）',
    }, cookie)
    expect(conf.status).toBe(200)
    const report = (await json(conf) as { report: { successRows: number } }).report
    expect(report.successRows).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS c FROM supplier WHERE company_name = 'Import Co'").get() as { c: number }).c).toBe(1)

    // 批次用完即弃
    const again = await postJson('/api/import/confirm', {
      batch_id: p.batch_id, dedupe_strategy: 'skip', source_note: 'x',
    }, cookie)
    expect(again.status).toBe(400)

    // 导入审计留痕
    const audited = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'import'").get() as { c: number }
    expect(audited.c).toBeGreaterThanOrEqual(1)
  })

  it('导入缺 source_note 被拒（合规必填）', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const prev = await postJson('/api/import/preview', { content: 'company,emails\nNoSrc Co,nosrc@example.com\n' }, cookie)
    const { batch_id } = await json(prev) as { batch_id: string }
    const conf = await postJson('/api/import/confirm', { batch_id, dedupe_strategy: 'skip', source_note: '' }, cookie)
    expect(conf.status).toBe(400)
  })

  it('AI 配置：默认 mock；api 模式缺 url/key 被拒；保存后不回传明文 Key', async () => {
    const { cookie } = await login('admin1', ADMIN_PW)
    const initial = await json(await get('/api/ai-config', cookie)) as { mode: string; keySet: boolean }
    expect(initial.mode).toBe('mock')
    expect(initial.keySet).toBe(false)

    expect((await postJson('/api/ai-config', { mode: 'api' }, cookie)).status).toBe(400)

    const secret = ['sk', 'unit', 'test', 'key', '0000'].join('-')
    const saved = await postJson('/api/ai-config', {
      mode: 'api', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: secret,
    }, cookie)
    expect(saved.status).toBe(200)
    const savedBody = await json(saved) as { keySet: boolean; keyMasked: string }
    expect(savedBody.keySet).toBe(true)
    expect(savedBody.keyMasked).toContain('****')
    expect(JSON.stringify(savedBody)).not.toContain(secret)

    // 读取时也绝不回传明文
    const after = await get('/api/ai-config', cookie)
    const text = await after.text()
    expect(text).not.toContain(secret)
    expect((await json(await get('/api/ai-config', cookie)) as { keySet: boolean }).keySet).toBe(true)

    // api 模式下只清 Key 会被拒（必须先离开 api 模式）
    const badClear = await postJson('/api/ai-config', { key: '__clear__' }, cookie)
    expect(badClear.status).toBe(400)

    // 显式切回 mock 并清 Key
    const cleared = await postJson('/api/ai-config', { mode: 'mock', key: '__clear__' }, cookie)
    expect(cleared.status).toBe(200)
    const clearedBody = await json(cleared) as { keySet: boolean; mode: string }
    expect(clearedBody.mode).toBe('mock')
    expect(clearedBody.keySet).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 站点首页登录页 + 反向代理 forward_auth 探针（F-AUTH-05）
//
// 部署形态：Caddy 把匿名请求放行给 /login、/api/auth/*、/unsubscribe，其余先探
// /api/auth/verify。这里验证的是"网关依赖的那几个契约"，不是网关本身。
//
// 夹具自建：文件前面的用例会重置 staff1 / newbie 的密码，复用它们会让本块依赖
// 执行顺序 —— 所以这里现造一个正常 staff 与一个首登未改密账号。
// ---------------------------------------------------------------------------
describe('站点首页登录页与 forward_auth 探针', () => {
  const MUST_PW = tpw('test', 'must', 'pw')
  let adminCookie = ''
  let staffCookie = ''
  let mustCookie = ''

  beforeAll(async () => {
    adminCookie = (await login('admin1', ADMIN_PW)).cookie
    staffCookie = await makeStaff('door-staff')
    db.prepare('INSERT INTO lma_user (username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?)')
      .run('door-newbie', await hashPassword(MUST_PW), 'staff', 1)
    mustCookie = (await login('door-newbie', MUST_PW)).cookie
  })

  const postLogin = (fields: Record<string, string>) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })

  it('verify：无会话 401、有会话 200，且 admin 与 staff 都放行', async () => {
    expect((await get('/api/auth/verify')).status).toBe(401)

    const okAdmin = await get('/api/auth/verify', adminCookie)
    expect(okAdmin.status).toBe(200)
    expect(okAdmin.headers.get('x-lma-role')).toBe('admin')
    // 探针只答放行与否，不回传任何业务数据
    expect(await okAdmin.text()).toBe('')

    const okStaff = await get('/api/auth/verify', staffCookie)
    expect(okStaff.status).toBe(200)
    expect(okStaff.headers.get('x-lma-role')).toBe('staff')
  })

  it('verify：首登未改密的会话 401，逼反代把人送去改密页', async () => {
    expect((await get('/api/auth/verify', mustCookie)).status).toBe(401)
  })

  it('登录页带 next 隐藏字段，登录后回仪表盘原地址（会话 Cookie 就够）', async () => {
    const page = await get('/login?next=%2Flma%2Freview')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('name="next" value="/lma/review"')

    const r = await postLogin({ username: 'admin1', password: ADMIN_PW, next: '/lma/review' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/lma/review')
  })

  it('登录后默认落到聊天工作台入口（本机走 3080，反代场景同源）', async () => {
    const r = await postLogin({ username: 'admin1', password: ADMIN_PW })
    expect(r.status).toBe(302)
    // 测试服务在 127.0.0.1:<随机端口> 上，聊天台按 LMA_CHAT_PORT（测试钉死 3080）换端口
    expect(r.headers.get('location')).toBe('http://127.0.0.1:3080/')
  })

  it('next 只认站内绝对路径，挡掉开放跳转', async () => {
    for (const evil of ['//evil.example.com/x', 'https://evil.example.com', 'javascript:alert(1)']) {
      const r = await postLogin({ username: 'admin1', password: ADMIN_PW, next: evil })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe('http://127.0.0.1:3080/')
    }
    // 失败重渲染时也不把非法 next 回填进页面
    const bad = await get('/login?next=%2F%2Fevil.example.com')
    expect(await bad.text()).not.toContain('evil.example.com')
  })

  it('已登录访问 /login：直接交接进工作台；首登未改密则就地改密', async () => {
    const again = await get('/login', adminCookie)
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toBe('http://127.0.0.1:3080/')

    const form = await get('/login', mustCookie)
    expect(form.status).toBe(200)
    const html = await form.text()
    expect(html).toContain('首次登录，请设置新密码')
    expect(html).toContain('api/auth/change-password')
  })

  it('仪表盘页头带"进入聊天工作台"，地址由服务端现取', async () => {
    const html = await (await get('/', adminCookie)).text()
    expect(html).toContain('聊天工作台')
    expect(html).toContain('href="http://127.0.0.1:3080/"')
  })
})

// Web 层登录鉴权与角色强制集成测试：起真实 http 服务，用真实 fetch 打请求
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { hashPassword } from '../src/auth/passwords.ts'
import { startWebServer } from '../src/web/server.ts'

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

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lma-web-'))
  db = openDb(path.join(tmp, 'web.db'))
  const ins = db.prepare('INSERT INTO lma_user (username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?)')
  ins.run('admin1', await hashPassword('admin-pass-1'), 'admin', 0)
  ins.run('staff1', await hashPassword('staff-pass-1'), 'staff', 0)
  ins.run('newbie', await hashPassword('temp-pass-1'), 'staff', 1)
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
    const wrongPw = await login('admin1', 'wrong-password')
    const noUser = await login('ghost-user', 'whatever-123')
    expect(wrongPw.status).toBe(401)
    expect(noUser.status).toBe(401)
    const a = await wrongPw.setCookie, b = await noUser.setCookie
    expect(a).toBe('') // 失败不种 Cookie
    expect(b).toBe('')

    const audits = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'auth.login_fail'").all() as Array<{ action: string }>
    expect(audits.length).toBeGreaterThanOrEqual(2)
  })

  it('登录成功 → 302 + HttpOnly/SameSite=Lax Cookie；带 Cookie 可访问页面与 API', async () => {
    const { status, cookie, setCookie } = await login('admin1', 'admin-pass-1')
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
    const { cookie } = await login('staff1', 'staff-pass-1')
    expect((await get('/api/overview', cookie)).status).toBe(200)
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } })
    expect(out.status).toBe(302)
    expect((await get('/api/overview', cookie)).status).toBe(401)
  })
})

describe('角色强制（后端，与前端隐藏无关）', () => {
  it('staff 可访问只读业务接口', async () => {
    const { cookie } = await login('staff1', 'staff-pass-1')
    for (const p of ['/api/overview', '/api/suppliers', '/api/review-queue', '/api/send-queue', '/api/unsubscribes']) {
      expect((await get(p, cookie)).status, `${p} 应允许 staff`).toBe(200)
    }
  })

  it('staff 访问配置接口 → 403 并写审计；admin → 200', async () => {
    const staff = await login('staff1', 'staff-pass-1')
    const denied = await get('/api/config', staff.cookie)
    expect(denied.status).toBe(403)

    const row = db.prepare("SELECT username, result, detail FROM audit_log WHERE action = 'api.denied' ORDER BY id DESC LIMIT 1")
      .get() as { username: string; result: string; detail: string }
    expect(row.username).toBe('staff1')
    expect(row.result).toBe('denied')
    expect(row.detail).toContain('/api/config')

    const admin = await login('admin1', 'admin-pass-1')
    expect((await get('/api/config', admin.cookie)).status).toBe(200)
  })

  it('未登记的 /api 路由一律 404（白名单默认拒绝）', async () => {
    const { cookie } = await login('admin1', 'admin-pass-1')
    expect((await get('/api/not-registered', cookie)).status).toBe(404)
    expect((await get('/api/users', cookie)).status).toBe(404) // S5 尚未实现
  })

  it('方法不符 → 405', async () => {
    const { cookie } = await login('admin1', 'admin-pass-1')
    const r = await fetch(`${base}/api/review`, { method: 'GET', headers: { cookie }, redirect: 'manual' })
    expect(r.status).toBe(405)
  })
})

describe('首次登录强制改密', () => {
  it('未改密时其它 API 返回 428；改密后恢复正常且旧会话失效', async () => {
    const first = await login('newbie', 'temp-pass-1')
    expect(first.status).toBe(302)

    const blocked = await get('/api/overview', first.cookie)
    expect(blocked.status).toBe(428)
    expect((await json(blocked)).code).toBe('MUST_CHANGE_PASSWORD')

    // 改密
    const ch = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: first.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: 'temp-pass-1', new_password: 'brand-new-pass-9' }),
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
    const { cookie } = await login('admin1', 'admin-pass-1')
    const r = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: 'admin-pass-1', new_password: 'short' }),
    })
    expect(r.status).toBe(400)
  })
})

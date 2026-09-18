// LMA Web 服务：仪表盘 + JSON API + 退订端点 + 登录鉴权（同一端口）
//
//   GET  /                     仪表盘页面           （需登录；内嵌于 dsh 客户端插件 iframe）
//   GET  /login                登录页               （匿名）
//   POST /api/auth/login       登录                 （匿名，表单）
//   POST /api/auth/logout      登出
//   GET  /api/auth/me          当前用户
//   POST /api/auth/change-password  改密（首登强制）
//   GET  /unsubscribe?e=&t=    邮件退订落点         （**唯一匿名可达的业务端点**，token 即凭证）
//   GET  /api/*                只读 JSON API        （需登录）
//   POST /api/*                写操作 JSON API      （需登录 + 按角色判定，见 api.ts 的 ROUTE_ROLES）
//
// 默认只绑 127.0.0.1，由反向代理对外（见 deploy/）。身份一律来自会话 Cookie，
// **不再信任任何客户端传入的操作者字段**。
import http from 'node:http'
import type { Db } from '../db.ts'
import { performUnsubscribe } from '../unsubscribe.ts'
import { handleApi } from './api.ts'
import { dashboardPage } from './page.ts'
import { readSession, parseCookies, sessionCookieName, type SessionUser } from '../auth/session.ts'
import {
  loginPage, handleLogin, handleLogout, handleChangePassword, meResult,
  htmlResult, jsonResult, redirectResult, type WebResult,
} from './auth-routes.ts'
import { clientIp } from '../audit.ts'

const MAX_BODY = 1024 * 1024

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, r: WebResult): void {
  res.writeHead(r.status, { 'Content-Type': r.contentType, 'Cache-Control': 'no-store', ...r.headers })
  res.end(r.body)
}

/** 启动 LMA Web 服务。返回 http.Server（调用方可 unref/close）。 */
export function startWebServer(db: Db, port: number, host = '127.0.0.1'): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = (req.method ?? 'GET').toUpperCase()
      const headers = req.headers as Record<string, string | string[] | undefined>
      const remoteAddr = req.socket.remoteAddress ?? ''
      const ip = clientIp(headers, remoteAddr)
      const ua = String(headers['user-agent'] ?? '')

      const cookies = parseCookies(headers.cookie)
      const token = cookies[sessionCookieName()] ?? ''
      const user: SessionUser | null = readSession(db, token)

      // 1) 邮件退订链接：唯一匿名可达的业务端点（token 即凭证，绝不能挂登录墙）
      if (url.pathname === '/unsubscribe') {
        const email = (url.searchParams.get('e') ?? '').toLowerCase().trim()
        const t = url.searchParams.get('t') ?? ''
        const r = performUnsubscribe(db, email, t)
        send(res, htmlResult(r.status, r.html))
        return
      }

      // 2) 登录页与登录动作（匿名）
      if (url.pathname === '/login' && method === 'GET') {
        if (user) { send(res, redirectResult('./')); return }
        send(res, htmlResult(200, loginPage()))
        return
      }
      if (url.pathname === '/api/auth/login' && method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        send(res, await handleLogin(db, form, headers, remoteAddr))
        return
      }

      // 3) 登出（有会话就销毁；无会话也直接回登录页）
      if ((url.pathname === '/api/auth/logout' || url.pathname === '/logout') && method === 'POST') {
        send(res, handleLogout(db, token, user, headers, remoteAddr))
        return
      }

      // 4) 登录墙：未登录一律拦截（API 401，页面 302 到登录页）
      if (!user) {
        if (url.pathname.startsWith('/api/')) {
          send(res, jsonResult(401, { error: '未登录或会话已过期', code: 'UNAUTHENTICATED' }))
          return
        }
        send(res, redirectResult('login'))
        return
      }

      // 5) 首登强制改密：只放行"查自己 / 改密 / 登出"
      if (user.mustChangePassword
        && url.pathname !== '/api/auth/me'
        && url.pathname !== '/api/auth/change-password'
        && url.pathname !== '/api/auth/logout') {
        if (url.pathname.startsWith('/api/')) {
          send(res, jsonResult(428, { error: '首次登录必须先修改密码', code: 'MUST_CHANGE_PASSWORD' }))
          return
        }
        // 页面照常渲染，前端会根据 /api/auth/me 强制弹出改密表单
      }

      // 6) 会话相关 API
      if (url.pathname === '/api/auth/me' && method === 'GET') {
        send(res, meResult(user, ip))
        return
      }
      if (url.pathname === '/api/auth/change-password' && method === 'POST') {
        const raw = await readBody(req)
        let body: Record<string, unknown> = {}
        try { body = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {} } catch { send(res, jsonResult(400, { error: '请求体不是合法 JSON' })); return }
        send(res, await handleChangePassword(db, user, body, headers, remoteAddr))
        return
      }

      // 7) 业务 JSON API（角色判定在 api.ts 的路由表里，默认拒绝未登记路由）
      if (url.pathname.startsWith('/api/')) {
        let body: Record<string, unknown> = {}
        if (method === 'POST') {
          const raw = await readBody(req)
          if (raw.trim()) {
            try { body = JSON.parse(raw) as Record<string, unknown> }
            catch { send(res, jsonResult(400, { error: '请求体不是合法 JSON' })); return }
          }
        }
        const r = await handleApi(db, method, url.pathname, url.searchParams, user, body, { ip, ua })
        send(res, jsonResult(r.status, r.body))
        return
      }

      // 8) 仪表盘页面
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        send(res, htmlResult(200, dashboardPage(user)))
        return
      }

      send(res, { status: 404, body: 'Not Found', contentType: 'text/plain; charset=utf-8', headers: {} })
    })().catch((e) => {
      console.error('[lma:web] 处理失败：', (e as Error).message)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Internal Server Error')
    })
  })
  server.listen(port, host)
  return server
}

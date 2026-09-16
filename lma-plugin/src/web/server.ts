// LMA Web 仪表盘服务：整合在同一个 HTTP 端口上
//   GET  /                     → 仪表盘页面（内嵌于 dsh 客户端插件 iframe）
//   GET  /unsubscribe?e=&t=    → 邮件退订链接落点（校验 token，幂等）
//   GET  /api/*                → JSON API（只读）
//   POST /api/*                → JSON API（写操作校验 X-LMA-Operator ∈ LMA_ADMINS）
// 默认只绑 127.0.0.1，不对外暴露。
import http from 'node:http'
import type { Db } from '../db.ts'
import { performUnsubscribe } from '../unsubscribe.ts'
import { handleApi } from './api.ts'
import { dashboardPage } from './page.ts'

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 启动 LMA Web 仪表盘 + 退订端点（同一端口）。返回 http.Server（调用方可 unref/close）。 */
export function startWebServer(db: Db, port: number, host = '127.0.0.1'): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = (req.method ?? 'GET').toUpperCase()

      // 1) 邮件退订链接（HTML 确认页，任何人可访问——token 即凭证）
      if (url.pathname === '/unsubscribe') {
        const email = (url.searchParams.get('e') ?? '').toLowerCase().trim()
        const token = url.searchParams.get('t') ?? ''
        const r = performUnsubscribe(db, email, token)
        res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(r.html)
        return
      }

      // 2) JSON API
      if (url.pathname.startsWith('/api/')) {
        let body: Record<string, unknown> = {}
        if (method === 'POST') {
          const raw = await readBody(req)
          if (raw.trim()) {
            try { body = JSON.parse(raw) as Record<string, unknown> }
            catch { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
          }
        }
        const operator = (req.headers['x-lma-operator'] ?? '').toString().trim()
        const r = handleApi(db, method, url.pathname, url.searchParams, operator, body)
        if (r) { sendJson(res, r.status, r.body); return }
        sendJson(res, 404, { error: '接口不存在' })
        return
      }

      // 3) 仪表盘页面
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(dashboardPage())
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    })().catch((e) => {
      console.error('[lma:web] 处理失败：', (e as Error).message)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Internal Server Error')
    })
  })
  server.listen(port, host)
  return server
}

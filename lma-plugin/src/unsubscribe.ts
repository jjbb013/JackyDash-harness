// 退订 HTTP 端点（F-COMP-01/02 最后一公里）：页脚与 List-Unsubscribe 头的链接落点
// GET /unsubscribe?e=<email>&t=<hmac token> → 校验 token → 加入退订名单 + 停发 + 审计 → HTML 确认页
// 独立 node:http 服务（零依赖）；生产环境用 Nginx 将 LMA_BASE_URL 的 /unsubscribe 反代到本端口
import http from 'node:http'
import crypto from 'node:crypto'
import type { Db } from './db.ts'
import { unsubscribeToken } from './ai.ts'
import { audit } from './audit.ts'
import { sqlNow, escapeHtml } from './util.ts'

const PAGE = (title: string, body: string) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#222}
h1{font-size:22px}p{line-height:1.7;color:#555}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`

/** 常数时间校验退订 token，避免被时序侧信道爆破。 */
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expect = unsubscribeToken(email)
  return token.length === expect.length &&
    crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expect, 'utf8'))
}

/**
 * 执行退订（幂等）：写退订名单、停发该邮箱全部供应商、记审计。
 * @returns HTTP 状态与确认页 HTML。
 */
export function performUnsubscribe(db: Db, email: string, token: string): { status: number; html: string } {
  if (!email || !verifyUnsubscribeToken(email, token)) {
    return {
      status: 400,
      html: PAGE('链接无效', '退订链接无效或已过期，请直接回复邮件告知我们，我们会立即处理。'),
    }
  }
  db.prepare('INSERT OR IGNORE INTO unsubscribe_list (email, source, unsubscribed_at, handled_by, note) VALUES (?, ?, ?, ?, ?)')
    .run(email, 'unsubscribe_link', sqlNow(), null, '退订链接点击')
  db.prepare(`UPDATE supplier SET status = 'unsubscribed', updated_at = datetime('now') WHERE email = ? AND deleted_at IS NULL`).run(email)
  audit(db, null, 'unsubscribe_link_click', 'unsubscribe_list', null, { email })
  return {
    status: 200,
    html: PAGE('已退订', `邮箱 <strong>${escapeHtml(email)}</strong> 已成功退订，不会再收到我们的推广邮件。如改变主意，可随时回复任意一封邮件告知我们。`),
  }
}

/** 独立的退订端点服务（Web 仪表盘服务内含同一端点；此服务供测试与单独部署使用）。 */
export function startUnsubscribeServer(db: Db, port: number): http.Server {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/unsubscribe') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not Found')
        return
      }
      const email = (url.searchParams.get('e') ?? '').toLowerCase().trim()
      const token = url.searchParams.get('t') ?? ''
      const r = performUnsubscribe(db, email, token)
      res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(r.html)
    } catch (e) {
      console.error('[lma:unsubscribe] 处理失败：', (e as Error).message)
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE('处理失败', '服务器开小差了，请稍后重试，或直接回复邮件告知我们。'))
    }
  })
  server.listen(port)
  return server
}

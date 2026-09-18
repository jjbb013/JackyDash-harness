// 发信（PRD 5.7）：smtp 走 nodemailer（可选依赖，未安装时回退 log 模式）；log 模式仅记录事件
import type { Db } from './db.ts'
import { sqlNow } from './util.ts'
import { buildFooter, unsubscribeToken, type SupplierLike } from './ai.ts'

export interface DraftLike {
  id: number
  subject: string
  body: string
}

const SMTP_HOST = process.env.LMA_SMTP_HOST ?? ''
const SMTP_PORT = parseInt(process.env.LMA_SMTP_PORT ?? '465', 10)
const SMTP_SECURE = (process.env.LMA_SMTP_SECURE ?? 'true') !== 'false'
const SMTP_USER = process.env.LMA_SMTP_USER ?? ''
const SMTP_PASS = process.env.LMA_SMTP_PASS ?? ''
const MAIL_FROM = process.env.LMA_MAIL_FROM ?? SMTP_USER
const BASE_URL = (process.env.LMA_BASE_URL ?? 'http://127.0.0.1:3081').replace(/\/+$/, '')

let transport: unknown = null

function smtpConfigured(): boolean {
  return Boolean(SMTP_HOST && SMTP_USER)
}

async function getTransport(): Promise<unknown> {
  if (transport) return transport
  try {
    const nodemailer = await import('nodemailer') as typeof import('nodemailer')
    transport = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  } catch (e) {
    console.warn('[lma] nodemailer 不可用，回退 log 模式：', (e as Error).message)
    transport = null
  }
  return transport
}

export async function sendDraftMail(db: Db, draft: DraftLike, supplier: SupplierLike): Promise<{ messageId: string | null; mode: string }> {
  const text = draft.body + buildFooter(db, supplier, BASE_URL)
  // List-Unsubscribe 头与正文页脚保持一致：优先 mailto 回信退订（RFC 2369 标准写法，
  // 邮件客户端会显示「退订」按钮）；未配置发件地址时回退到本地 HTTP 端点。
  const unsubLink = MAIL_FROM
    ? `mailto:${MAIL_FROM}?subject=Unsubscribe`
    : `${BASE_URL}/unsubscribe?e=${encodeURIComponent(supplier.email)}&t=${unsubscribeToken(supplier.email)}`

  let messageId: string | null = null
  if (smtpConfigured()) {
    const tr = await getTransport() as
      { sendMail: (o: Record<string, unknown>) => Promise<{ messageId?: string }> } | null
    if (tr) {
      const info = await tr.sendMail({
        from: MAIL_FROM, to: supplier.email, subject: draft.subject, text,
        headers: { 'List-Unsubscribe': `<${unsubLink}>` },
      })
      messageId = info.messageId ?? null
    } else {
      console.log(`[lma:mail:log] to=${supplier.email} subject="${draft.subject}"`)
    }
  } else {
    console.log(`[lma:mail:log] to=${supplier.email} subject="${draft.subject}"`)
  }

  db.prepare(
    `INSERT INTO email_event (supplier_id, draft_id, event_type, event_time, meta) VALUES (?, ?, 'sent', ?, ?)`,
  ).run(supplier.id, draft.id, sqlNow(), JSON.stringify({ mode: smtpConfigured() ? 'smtp' : 'log', messageId, to: supplier.email, subject: draft.subject }))

  db.prepare(`UPDATE supplier SET status = 'sent', last_contact_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(supplier.id)
  return { messageId, mode: smtpConfigured() ? 'smtp' : 'log' }
}

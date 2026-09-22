// 发信（PRD 5.7）：smtp 走 nodemailer（可选依赖，未安装时回退 log 模式）；log 模式仅记录事件
import type { Db } from './db.ts'
import { sqlNow } from './util.ts'
import { buildFooter, unsubscribeToken, type SupplierLike } from './ai.ts'

export interface DraftLike {
  id: number
  subject: string
  body: string
}

// SMTP 配置解析：优先网页端保存的 db 配置（app_config.smtp_config），env 兜底
import { getSmtpConfig } from './db.ts'

const ENV_SMTP_HOST = process.env.LMA_SMTP_HOST ?? ''
const ENV_SMTP_PORT = parseInt(process.env.LMA_SMTP_PORT ?? '465', 10)
const ENV_SMTP_SECURE = (process.env.LMA_SMTP_SECURE ?? 'true') !== 'false'
const ENV_SMTP_USER = process.env.LMA_SMTP_USER ?? ''
const ENV_SMTP_PASS = process.env.LMA_SMTP_PASS ?? ''
const ENV_MAIL_FROM = process.env.LMA_MAIL_FROM ?? ''
const BASE_URL = (process.env.LMA_BASE_URL ?? 'http://127.0.0.1:3081').replace(/\/+$/, '')

let transport: unknown = null
let transportFingerprint = ''

function smtpOf(db: Db) {
  const c = getSmtpConfig(db)
  const host = c.host || ENV_SMTP_HOST
  const user = c.user || ENV_SMTP_USER
  return {
    host,
    user,
    port: c.port || ENV_SMTP_PORT,
    secure: c.secure ?? ENV_SMTP_SECURE,
    pass: c.pass || ENV_SMTP_PASS,
    from: c.from || ENV_MAIL_FROM || user,
  }
}

function smtpConfigured(db: Db): boolean {
  const s = smtpOf(db)
  return Boolean(s.host && s.user)
}

async function getTransport(db: Db): Promise<unknown> {
  const s = smtpOf(db)
  const fp = `${s.host}|${s.port}|${s.secure}|${s.user}|${s.pass}`
  if (transport && fp === transportFingerprint) return transport
  transport = null
  try {
    const nodemailer = await import('nodemailer') as typeof import('nodemailer')
    transport = nodemailer.createTransport({
      host: s.host, port: s.port, secure: s.secure,
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    })
    transportFingerprint = fp
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
  const smtp = smtpOf(db)
  const unsubLink = smtp.from
    ? `mailto:${smtp.from}?subject=Unsubscribe`
    : `${BASE_URL}/unsubscribe?e=${encodeURIComponent(supplier.email)}&t=${unsubscribeToken(supplier.email)}`

  let messageId: string | null = null
  if (smtpConfigured(db)) {
    const tr = await getTransport(db) as
      { sendMail: (o: Record<string, unknown>) => Promise<{ messageId?: string }> } | null
    if (tr) {
      const info = await tr.sendMail({
        from: smtp.from, to: supplier.email, subject: draft.subject, text,
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
  ).run(supplier.id, draft.id, sqlNow(), JSON.stringify({ mode: smtpConfigured(db) ? 'smtp' : 'log', messageId, to: supplier.email, subject: draft.subject }))

  db.prepare(`UPDATE supplier SET status = 'sent', last_contact_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(supplier.id)
  return { messageId, mode: smtpConfigured(db) ? 'smtp' : 'log' }
}

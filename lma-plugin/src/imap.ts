// 收信轮询（PRD 5.8 / F-TRACK-01~05）：IMAP 每 5 分钟轮询收件箱
// 识别：回复 → 标记「需人工处理」；退信 → 标记邮箱无效；退订关键词 → 加入退订名单并停止发送
// imapflow 为可选依赖；未安装或未配置时跳过（可用工具人工补录事件）
import type { Db } from './db.ts'
import { sqlNow, extractEmail } from './util.ts'
import { audit } from './audit.ts'

const IMAP_ENABLED = process.env.LMA_IMAP_ENABLED === 'true'
const IMAP_HOST = process.env.LMA_IMAP_HOST ?? ''
const IMAP_PORT = parseInt(process.env.LMA_IMAP_PORT ?? '993', 10)
const IMAP_TLS = (process.env.LMA_IMAP_TLS ?? 'true') !== 'false'
const IMAP_USER = process.env.LMA_IMAP_USER ?? ''
const IMAP_PASS = process.env.LMA_IMAP_PASS ?? ''

const BOUNCE_FROM = /(mailer-daemon|postmaster)/i
const BOUNCE_SUBJ = /(delivery status notification|undeliverable|failed delivery|退回|退信|投递失败)/i
const UNSUB_KEYWORDS = /\b(unsubscribe|opt\s*-?\s*out|退订|取消订阅)\b/i

function classify(from: string, subject: string, text: string): 'bounced' | 'unsubscribed' | 'replied' {
  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subject)) return 'bounced'
  if (UNSUB_KEYWORDS.test(subject + ' ' + text)) return 'unsubscribed'
  return 'replied'
}

export function applyResult(db: Db, supplier: { id: number; email: string }, type: 'delivered' | 'replied' | 'bounced' | 'unsubscribed', meta: unknown, operator: string | null = null): void {
  const now = sqlNow()
  db.prepare('INSERT INTO email_event (supplier_id, event_type, event_time, meta) VALUES (?, ?, ?, ?)')
    .run(supplier.id, type, now, JSON.stringify(meta))
  if (type === 'bounced') {
    db.prepare(`UPDATE supplier SET status = 'invalid', updated_at = datetime('now') WHERE id = ?`).run(supplier.id)
  } else if (type === 'unsubscribed') {
    db.prepare('INSERT OR IGNORE INTO unsubscribe_list (email, source, unsubscribed_at, handled_by, note) VALUES (?, ?, ?, ?, ?)')
      .run(supplier.email, 'reply_keyword', now, operator, 'IMAP 关键词识别')
    db.prepare(`UPDATE supplier SET status = 'unsubscribed', updated_at = datetime('now') WHERE id = ?`).run(supplier.id)
    audit(db, operator, 'unsubscribe_auto', 'supplier', supplier.id, { source: 'reply_keyword' })
  } else if (type === 'replied') {
    // delivered 只记录事件，不得改变供应商状态（否则会被误判为"已回复"而阻断跟进）
    db.prepare(`UPDATE supplier SET status = 'replied', replied_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(supplier.id)
  }
}

export async function pollOnce(db: Db): Promise<{ skipped: boolean; handled?: number }> {
  if (!IMAP_ENABLED || !IMAP_HOST || !IMAP_USER) return { skipped: true }

  let ImapFlow: typeof import('imapflow').ImapFlow
  try {
    ({ ImapFlow } = await import('imapflow'))
  } catch (e) {
    console.warn('[lma:imap] imapflow 不可用，跳过轮询：', (e as Error).message)
    return { skipped: true }
  }

  const sentMetaByMsgId = new Map<string, number>()
  for (const r of db.prepare(`SELECT supplier_id, meta FROM email_event WHERE event_type = 'sent' AND meta IS NOT NULL`).all() as Array<{ supplier_id: number; meta: string }>) {
    try {
      const m = JSON.parse(r.meta) as { messageId?: string }
      if (m.messageId) sentMetaByMsgId.set(String(m.messageId).replace(/[<>]/g, ''), r.supplier_id)
    } catch { /* ignore */ }
  }

  const client = new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: IMAP_TLS,
    auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false,
  })
  let handled = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const unseen = await client.search({ seen: false })
      if (unseen.length) {
        for await (const msg of client.fetch(unseen, { envelope: true, source: true, uid: true })) {
          const fromRaw = msg.envelope?.from?.[0]?.address ?? ''
          const fromEmail = extractEmail(fromRaw)
          const subject = msg.envelope?.subject ?? ''
          let text = ''
          try { text = msg.source?.toString('utf8') ?? '' } catch { /* ignore */ }
          const type = classify(fromRaw, subject, text)
          // 按邮箱或 In-Reply-To/References 匹配
          let supplier: { id: number; email: string } | undefined
          if (fromEmail) {
            supplier = db.prepare('SELECT id, email FROM supplier WHERE email = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1')
              .get(fromEmail) as { id: number; email: string } | undefined
          }
          if (!supplier) {
            const headers = msg.envelope?.headers as Map<string, unknown> | undefined
            for (const h of ['in-reply-to', 'references']) {
              const val = headers?.get?.(h) ?? ''
              const ids = String(val).match(/<[^>]+>/g) ?? []
              for (const id of ids) {
                const supId = sentMetaByMsgId.get(id.replace(/[<>]/g, '').trim())
                if (supId) {
                  supplier = db.prepare('SELECT id, email FROM supplier WHERE id = ?').get(supId) as { id: number; email: string } | undefined
                  break
                }
              }
              if (supplier) break
            }
          }
          // 回退：部分 IMAP 服务端的 envelope 不含 headers，从原始邮件头解析 In-Reply-To/References
          if (!supplier && text) {
            const headerBlock = text.slice(0, Math.min(text.length, 16384))
            for (const line of headerBlock.match(/^(in-reply-to|references):[ \t]*([^\r\n]+([ \t]+\S[^\r\n]*)*)/gim) ?? []) {
              const ids = line.match(/<[^>]+>/g) ?? []
              for (const id of ids) {
                const supId = sentMetaByMsgId.get(id.replace(/[<>]/g, '').trim())
                if (supId) {
                  supplier = db.prepare('SELECT id, email FROM supplier WHERE id = ?').get(supId) as { id: number; email: string } | undefined
                  break
                }
              }
              if (supplier) break
            }
          }
          if (supplier) {
            applyResult(db, supplier, type, { from: fromEmail, subject, imapUid: msg.uid })
            handled++
          }
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true })
        }
      }
    } finally {
      lock.release()
    }
  } catch (e) {
    console.error('[lma:imap] 轮询失败：', (e as Error).message)
  } finally {
    await client.logout().catch(() => {})
  }
  return { skipped: false, handled }
}

export function startImapPolling(db: Db): void {
  if (!IMAP_ENABLED || !IMAP_HOST || !IMAP_USER) return
  const INTERVAL = 5 * 60 * 1000 // F-TRACK-01：每 5 分钟
  const tick = () => pollOnce(db).catch((e) => console.error('[lma:imap] tick error', (e as Error).message))
  tick()
  const timer = setInterval(tick, INTERVAL)
  timer.unref?.()
  console.log(`[lma] IMAP 轮询已启动（每 ${INTERVAL / 60000} 分钟）：${IMAP_USER}@${IMAP_HOST}`)
}

// 收信轮询（PRD 5.8 / F-TRACK-01~05）：IMAP 每 5 分钟轮询收件箱
// 识别：回复 → 标记「需人工处理」；退信 → 标记邮箱无效；退订关键词 → 加入退订名单并停止发送
// imapflow 为可选依赖；未安装或未配置时跳过（可用工具人工补录事件）
import type { Db } from './db.ts'
import { sqlNow, extractEmail } from './util.ts'
import { audit } from './audit.ts'

// IMAP 配置解析：优先网页端保存的 db 配置（app_config.imap_config），env 兜底
import { getImapConfig } from './db.ts'

const ENV_IMAP_ENABLED = process.env.LMA_IMAP_ENABLED === 'true'
const ENV_IMAP_HOST = process.env.LMA_IMAP_HOST ?? ''
const ENV_IMAP_PORT = parseInt(process.env.LMA_IMAP_PORT ?? '993', 10)
const ENV_IMAP_TLS = (process.env.LMA_IMAP_TLS ?? 'true') !== 'false'
const ENV_IMAP_USER = process.env.LMA_IMAP_USER ?? ''
const ENV_IMAP_PASS = process.env.LMA_IMAP_PASS ?? ''

function imapOf(db: Db) {
  const c = getImapConfig(db)
  return {
    enabled: c.enabled ?? ENV_IMAP_ENABLED,
    host: c.host || ENV_IMAP_HOST,
    port: c.port || ENV_IMAP_PORT,
    tls: c.tls ?? ENV_IMAP_TLS,
    user: c.user || ENV_IMAP_USER,
    pass: c.pass || ENV_IMAP_PASS,
  }
}

const BOUNCE_FROM = /(mailer-daemon|postmaster)/i
const BOUNCE_SUBJ = /(delivery status notification|undeliverable|failed delivery|退回|退信|投递失败)/i
// \b 只在 ASCII 词与非词字符之间成立，中日文字符两侧都不构成词边界，
// 因此中文关键词必须单独列出，绝不能包进 \b(...)\b 里（曾导致「退订/取消订阅」完全失效）
const UNSUB_KEYWORDS = /(\bunsubscribe\b|\bopt[-\s]?out\b|退订|取消订阅|停止发送|不再接收|不再联系|配信停止|配信解除)/i

// 引用历史里必然带着我方页脚的 "unsubscribe" 文案，直接扫全文会把普通回复误判成退订（假退订）。
// 只取收件人新写的正文（剔除邮件头、引用块与常见分隔符）参与关键词判定。
function newPortion(raw: string): string {
  const sep = raw.search(/\r?\n\r?\n/)
  const body = sep >= 0 ? raw.slice(sep) : raw
  const cuts: RegExp[] = [
    /\r?\n\s*>/,                                   // 引用行
    /\r?\n-{2,}\s*(?:original message|原始邮件|転送)/i,
    /\r?\n(?:on|le)\s.{0,80}wrote:/i,
    /\r?\n_{8,}/,
    /\r?\n(?:发件人|差出人|送信者|from)\s*[:：]/i,
  ]
  let cut = body.length
  for (const p of cuts) {
    const m = body.match(p)
    if (m && m.index !== undefined && m.index < cut) cut = m.index
  }
  return body.slice(0, cut).split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join('\n')
}

export function classify(from: string, subject: string, text: string): 'bounced' | 'unsubscribed' | 'replied' {
  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subject)) return 'bounced'
  // 主题由 IMAP envelope 解码，判定最可靠；正文只认新增内容
  if (UNSUB_KEYWORDS.test(subject) || UNSUB_KEYWORDS.test(newPortion(text))) return 'unsubscribed'
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
  const imap = imapOf(db)
  if (!imap.enabled || !imap.host || !imap.user) return { skipped: true }

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
    host: imap.host, port: imap.port, secure: imap.tls,
    auth: { user: imap.user, pass: imap.pass }, logger: false,
    socketTimeout: 120_000, greetingTimeout: 30_000,
  })
  // imapflow 在 socket 超时/断连时会 emit('error')。EventEmitter 上若无人监听 'error'，Node 会把它
  // 当未捕获异常直接抛出——实测后果是整个 dsh 进程崩溃退出（IMAP socket 超时 → harness 挂掉，
  // 3080/3081 全断）。必须挂兜底监听，让连接故障只影响本轮轮询。
  client.on('error', (e: Error) => {
    console.error('[lma:imap] 连接错误（已忽略，进程继续运行）：', e.message)
  })
  let handled = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      // 只扫描「首次外发之后」的未读邮件：否则会把收件箱全部历史与个人邮件都拉取一遍
      const firstSent = db.prepare(`SELECT MIN(event_time) AS t FROM email_event WHERE event_type = 'sent'`).get() as { t: string | null }
      if (!firstSent?.t) return { skipped: false, handled: 0 }
      const since = new Date(String(firstSent.t).replace(' ', 'T') + 'Z')
      since.setDate(since.getDate() - 2)
      const unseen = await client.search({ seen: false, since })
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
            // 仅把已匹配到供应商的邮件标记为已读；收件箱里其它未读邮件一律不碰
            await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true })
          }
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
  const imap = imapOf(db)
  if (!imap.enabled || !imap.host || !imap.user) return
  const INTERVAL = 5 * 60 * 1000 // F-TRACK-01：每 5 分钟
  const tick = () => pollOnce(db).catch((e) => console.error('[lma:imap] tick error', (e as Error).message))
  tick()
  const timer = setInterval(tick, INTERVAL)
  timer.unref?.()
  console.log(`[lma] IMAP 轮询已启动（每 ${INTERVAL / 60000} 分钟）：${imap.user}@${imap.host}`)
}

// 发送队列（PRD 5.7）：应用内调度，节流（默认 3 分钟）、每日上限（默认 20）、工作时段（对方当地时间）
// 内存态队列：进程重启后待发项丢失（草稿仍 approved，可重新入队）
import crypto from 'node:crypto'
import type { Db } from './db.ts'
import { getSendPolicy, type SendPolicyConfig } from './db.ts'
import { isValidEmail } from './util.ts'
import { isWorkingTime, nextWorkStartMs } from './timezone.ts'
import { sendDraftMail, type DraftLike } from './mailer.ts'

export interface QueueItem {
  id: string
  draftId: number
  supplierId: number
  dueAt: number
  reason: string | null
  tries: number
}

const queue: QueueItem[] = []
let lastSentAt = 0

export function initQueueState(db: Db): void {
  const row = db.prepare(`SELECT MAX(strftime('%s', event_time)) AS t FROM email_event WHERE event_type = 'sent'`).get() as { t: number | null } | undefined
  if (row?.t) lastSentAt = Number(row.t) * 1000
}

export function todaySentCount(db: Db): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const row = db.prepare(`SELECT COUNT(*) AS c FROM email_event WHERE event_type = 'sent' AND event_time >= ?`)
    .get(d.toISOString().slice(0, 19).replace('T', ' ')) as { c: number }
  return row?.c ?? 0
}

export function isUnsubscribed(db: Db, email: string): boolean {
  return !!db.prepare('SELECT 1 FROM unsubscribe_list WHERE email = ?').get(email)
}

export interface EnqueueResult {
  ok: boolean
  reason?: string
  queued?: boolean
  dueAt?: number
}

export function enqueue(db: Db, draft: DraftLike, supplier: { id: number; email: string; timezone: string | null; status: string }): EnqueueResult {
  const policy = getSendPolicy(db)

  if (isUnsubscribed(db, supplier.email)) return { ok: false, reason: '该邮箱已在退订名单，禁止发送' }
  if (supplier.status === 'unsubscribed' || supplier.status === 'invalid') {
    return { ok: false, reason: `供应商状态为 ${supplier.status}，禁止发送` }
  }
  if (!isValidEmail(supplier.email)) return { ok: false, reason: '邮箱格式非法' }

  const now = Date.now()
  let dueAt = now

  if (todaySentCount(db) >= policy.dailyLimit) {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return { ok: true, queued: true, dueAt: d.getTime(), reason: 'daily_limit（今日发送量已达上限，排至明早 9:00）' }
  }

  const throttleUntil = lastSentAt + policy.intervalMinutes * 60_000
  if (throttleUntil > now) dueAt = throttleUntil

  if (policy.checkWorkingHours) {
    if (!isWorkingTime(supplier.timezone, policy.workStart, policy.workEnd)) {
      const next = nextWorkStartMs(supplier.timezone, policy.workStart)
      return {
        ok: true, queued: true, dueAt: Math.max(dueAt, next),
        reason: `非对方工作时间（${supplier.timezone ?? '未知时区'}），排至下一个工作时段`,
      }
    }
  }

  queue.push({ id: crypto.randomUUID(), draftId: draft.id, supplierId: supplier.id, dueAt, reason: null, tries: 0 })
  return { ok: true, queued: dueAt > now + 1000, dueAt }
}

export async function processDue(db: Db): Promise<void> {
  const now = Date.now()
  const due = queue.filter((q) => q.dueAt <= now)
  for (const item of due) {
    const idx = queue.indexOf(item)
    if (idx >= 0) queue.splice(idx, 1)
    try {
      const draft = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(item.draftId) as DraftLike | undefined
      const supplier = db.prepare('SELECT * FROM supplier WHERE id = ? AND deleted_at IS NULL').get(item.supplierId) as
        { id: number; email: string; timezone: string | null; status: string } | undefined
      if (!draft || !supplier) continue
      const row = db.prepare('SELECT status FROM email_draft WHERE id = ?').get(item.draftId) as { status: string }
      if (row.status !== 'approved') continue // F-SEND-02
      if (isUnsubscribed(db, supplier.email)) continue // F-COMP-02 实时生效
      await sendDraftMail(db, draft, supplier)
      lastSentAt = Date.now()
    } catch (e) {
      item.tries++
      console.error('[lma:send-queue] 发送失败', item.draftId, (e as Error).message)
      if (item.tries < 3) queue.push(item)
      else console.error('[lma:send-queue] 重试 3 次仍失败，放弃该封：', item.draftId)
    }
  }
}

export function queueSnapshot(): QueueItem[] {
  return queue.map((q) => ({ ...q }))
}

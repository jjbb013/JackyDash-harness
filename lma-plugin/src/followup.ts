// 跟进规则（F-TRACK-06）：3 天未回发一封跟进，最多 2 封
// 默认 autoFollowup=false：只生成跟进草稿进审核队列；true 时自动批准并入发送队列
import type { Db } from './db.ts'
import { getSendPolicy } from './db.ts'
import { generateDraft, matchSupplier } from './ai.ts'
import { enqueue } from './sendqueue.ts'
import { audit } from './audit.ts'

export async function checkFollowups(db: Db, operator: string | null = null): Promise<{ scanned: number; created: number; autoSent: number; autoFollowup: boolean }> {
  const policy = getSendPolicy(db)
  const rows = db.prepare(
    `SELECT * FROM supplier
     WHERE deleted_at IS NULL AND status IN ('sent','follow_up') AND replied_at IS NULL
       AND last_contact_at IS NOT NULL AND follow_up_count < ?
       AND last_contact_at <= datetime('now', ?)`,
  ).all(policy.followupMax, `-${policy.followupAfterDays} days`) as Array<{
    id: number; company_name: string; contact_name: string | null; email: string; business: string | null
    networks: string | null; profile: string | null; country: string | null; preferred_language: string | null
    source: string | null; timezone: string | null; status: string; follow_up_count: number
  }>

  let created = 0, autoSent = 0
  for (const supplier of rows) {
    const match = await matchSupplier(db, supplier)
    const draftBody = await generateDraft(db, supplier, match, baseUrl())
    const info = db.prepare(
      `INSERT INTO email_draft (supplier_id, subject, body, language, match_analysis, match_score, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, datetime('now'), datetime('now'))`,
    ).run(
      supplier.id,
      `Re: ${supplier.company_name} — follow-up`.slice(0, 100),
      `[Follow-up ${supplier.follow_up_count + 1}]\n${draftBody.body}`,
      supplier.preferred_language ?? 'en', match.analysis, match.score, operator,
    )
    db.prepare(`UPDATE supplier SET follow_up_count = follow_up_count + 1, status = 'follow_up', updated_at = datetime('now') WHERE id = ?`)
      .run(supplier.id)
    created++

    if (policy.autoFollowup) {
      const draft = db.prepare('SELECT * FROM email_draft WHERE id = ?').get(info.lastInsertRowid) as
        { id: number; subject: string; body: string }
      db.prepare(`UPDATE email_draft SET status = 'approved', reviewer = ?, reviewed_at = datetime('now') WHERE id = ?`)
        .run(operator, draft.id)
      const r = enqueue(db, draft, supplier)
      if (r.ok) autoSent++
    }
    audit(db, operator, 'followup_created', 'email_draft', Number(info.lastInsertRowid), { supplierId: supplier.id })
  }
  return { scanned: rows.length, created, autoSent, autoFollowup: policy.autoFollowup }
}

function baseUrl(): string {
  return (process.env.LMA_BASE_URL ?? 'http://127.0.0.1:3081').replace(/\/+$/, '')
}

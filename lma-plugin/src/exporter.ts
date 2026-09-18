// 名单导出（工具层与 Web 层共用）：保证"网页点导出"与"lma_export_csv"输出一致、审计一致。
import type { Db } from './db.ts'
import { csvLine } from './util.ts'

export interface ExportFilters { country?: string; status?: string; q?: string }

export interface ExportResult { csv: string; rows: number; fields: string[] }

const FIELDS = [
  'company_name', 'contact_name', 'email', 'phone', 'website', 'business', 'networks',
  'country', 'timezone', 'preferred_language', 'source', 'match_score', 'status',
  'last_contact_at', 'created_at',
]

/** 导出供应商名单为 CSV（带 BOM，Excel 可直接打开），并写 export_log */
export function exportSuppliersCsv(db: Db, filters: ExportFilters, operator: string): ExportResult {
  const where = ['deleted_at IS NULL']
  const a: unknown[] = []
  if (filters.country) { where.push('country = ?'); a.push(filters.country) }
  if (filters.status) { where.push('status = ?'); a.push(filters.status) }
  if (filters.q) {
    where.push('(company_name LIKE ? OR email LIKE ? OR contact_name LIKE ? OR business LIKE ?)')
    const l = `%${filters.q}%`
    a.push(l, l, l, l)
  }

  const rows = db.prepare(
    `SELECT ${FIELDS.join(', ')} FROM supplier WHERE ${where.join(' AND ')} ORDER BY id`,
  ).all(...a) as Array<Record<string, unknown>>

  const lines = ['\uFEFF' + FIELDS.join(',')]
  for (const r of rows) lines.push(csvLine(FIELDS.map((f) => r[f])))

  db.prepare('INSERT INTO export_log (username, filters, fields, row_count) VALUES (?, ?, ?, ?)')
    .run(operator, JSON.stringify(filters), JSON.stringify(FIELDS), rows.length)

  return { csv: lines.join('\n'), rows: rows.length, fields: FIELDS }
}

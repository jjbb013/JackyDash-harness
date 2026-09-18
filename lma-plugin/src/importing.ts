// CSV 导入（两步：预览 → 确认）。**工具层与 Web 层共用**，避免"网页导入"与"lma_import_*"行为漂移。
// 批次暂存在内存里（1 小时过期），因为确认阶段要拿到预览时解析好的 rows + 字段映射。
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Db } from './db.ts'
import { parseCsv } from './csvparse.ts'
import {
  STANDARD_FIELDS, FIELD_LABELS, autoMapColumns, previewRows, executeImport,
  makeBatchId, type Mapping,
} from './csvpipeline.ts'
import { audit } from './audit.ts'

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
const BATCH_TTL_MS = 3600_000

export interface StagedBatch {
  rows: string[][]
  columns: string[]
  mapping: Mapping
  fileName: string
  createdAt: number
}

const batches = new Map<string, StagedBatch>()

export function stageBatch(id: string, b: StagedBatch): void { batches.set(id, b) }

export function getBatch(id: string): StagedBatch | null {
  const b = batches.get(id)
  if (!b) return null
  if (Date.now() - b.createdAt > BATCH_TTL_MS) { batches.delete(id); return null }
  return b
}

export function dropBatch(id: string): void { batches.delete(id) }

// 定期清理过期批次（unref，不阻塞进程退出）
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of batches) if (now - v.createdAt > BATCH_TTL_MS) batches.delete(k)
}, 600_000)
sweeper.unref?.()

export interface PreviewOptions {
  /** 文件绝对路径（与 content 二选一） */
  path?: string
  /** CSV 文本（与 path 二选一） */
  content?: string
  /** 缺失国家字段的填充值，如 NL */
  defaultCountry?: string
}

/** 第一步：解析 + 字段映射 + 校验统计 + 前 15 行样例，并暂存批次 */
export async function previewImport(db: Db, opts: PreviewOptions): Promise<Record<string, unknown>> {
  const p = String(opts.path ?? '')
  let content = String(opts.content ?? '')
  if (p && !content) {
    const buf = await fs.readFile(p)
    if (buf.length > MAX_IMPORT_BYTES) throw new Error('文件超过 5MB 上限')
    content = buf.toString('utf8')
  }
  if (!content.trim()) throw new Error('缺少 CSV 内容或路径')

  const { columns, rows } = parseCsv(content, 5000)
  if (!columns.length || !rows.length) throw new Error('CSV 为空或缺少表头')

  const mapping = autoMapColumns(columns)
  const { stats, preview } = previewRows(rows, mapping, db, String(opts.defaultCountry ?? ''))
  const batchId = makeBatchId()
  stageBatch(batchId, {
    rows, columns, mapping,
    fileName: p ? path.basename(p) : 'content.csv',
    createdAt: Date.now(),
  })

  return {
    batch_id: batchId,
    columns,
    mapping: Object.fromEntries(STANDARD_FIELDS.map((f) => [f, mapping[f]])),
    unmapped: STANDARD_FIELDS.filter((f) => mapping[f] === null),
    fieldLabels: FIELD_LABELS,
    stats,
    preview,
    next_step: '确认导入：提供 batch_id + dedupe_strategy + source_note（合规必填）',
  }
}

export interface ConfirmOptions {
  strategy: 'skip' | 'update' | 'create'
  sourceNote: string
  defaultCountry?: string
  defaultLanguage?: string
}

export type ImportReport = ReturnType<typeof executeImport>

/** 第二步：按策略落库（批次用后即弃） */
export function confirmImport(db: Db, batchId: string, opts: ConfirmOptions, username: string): ImportReport {
  const batch = getBatch(batchId)
  if (!batch) throw new Error('batch_id 不存在或已过期（1 小时），请重新预览')
  if (!opts.sourceNote.trim()) throw new Error('source_note 为合规必填（写明数据来源）')
  const report = executeImport(db, {
    batchId,
    rows: batch.rows,
    mapping: batch.mapping,
    strategy: opts.strategy,
    sourceNote: opts.sourceNote,
    defaultCountry: opts.defaultCountry,
    defaultLanguage: opts.defaultLanguage,
    username,
  })
  dropBatch(batchId)
  return report
}

/** 导入审计：工具层与 Web 层写同样的字段，便于事后对账 */
export function auditImport(db: Db, operator: string, report: ImportReport): void {
  audit(db, operator, 'import', 'import_log', null, {
    batchId: report.batchId, totalRows: report.totalRows, successRows: report.successRows,
    updatedRows: report.updatedRows, skippedRows: report.skippedRows, failedRows: report.failedRows,
    failureCount: report.failures.length,
  })
}

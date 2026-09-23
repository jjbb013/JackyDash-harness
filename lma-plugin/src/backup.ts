// 定时全量备份（邮件送达）：把系统核心表打包成一个 xlsx（多 sheet）附件，
// 邮件正文为备份摘要；发送走既有 SMTP 配置（sendRawMail）。调度在 main.ts 的每分钟 tick。
import type { Db } from './db.ts'
import { getConfig, setConfig, getSmtpConfig } from './db.ts'
import { audit } from './audit.ts'
import { sendRawMail } from './mailer.ts'

export interface BackupConfig {
  /** 总开关 */
  enabled: boolean
  /** 频率：daily=每天；weekly=每周日；monthly=每月 1 日（服务器本地时间） */
  schedule: 'daily' | 'weekly' | 'monthly'
  hour: number
  minute: number
  /** 收件邮箱（必填） */
  to: string
  /** 发件人（可选，默认 smtp_config.from） */
  from?: string
  /** 是否包含审计日志 sheet */
  includeAudit: boolean
  lastRunAt?: string
  lastResult?: string
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  schedule: 'daily',
  hour: 3,
  minute: 0,
  to: '',
  includeAudit: true,
}

export function getBackupConfig(db: Db): BackupConfig {
  return { ...DEFAULT_BACKUP_CONFIG, ...getConfig<Partial<BackupConfig>>(db, 'backup_config', {}) }
}

export function saveBackupConfig(db: Db, next: BackupConfig, operator: string): void {
  setConfig(db, 'backup_config', next, operator)
}

/** 表 → [列名数组, 取数 SQL]；user 表刻意不含 pass_hash（哈希不应随邮件外发） */
const SHEETS: Array<{ name: string; columns: string[]; sql: string }> = [
  {
    name: 'supplier',
    columns: ['id', 'company_name', 'contact_name', 'email', 'extra_emails', 'phone', 'website', 'business',
      'country', 'timezone', 'region', 'preferred_language', 'source', 'status', 'match_score',
      'last_contact_at', 'created_at', 'updated_at', 'deleted_at'],
    sql: `SELECT id, company_name, contact_name, email, extra_emails, phone, website, business,
      country, timezone, region, preferred_language, source, status, match_score,
      last_contact_at, created_at, updated_at, deleted_at FROM supplier`,
  },
  {
    name: 'email_draft',
    columns: ['id', 'supplier_id', 'subject', 'language', 'match_score', 'status', 'created_by', 'created_at', 'updated_at'],
    sql: `SELECT id, supplier_id, subject, language, match_score, status, created_by, created_at, updated_at FROM email_draft`,
  },
  {
    name: 'email_event',
    columns: ['id', 'supplier_id', 'draft_id', 'event_type', 'event_time', 'meta'],
    sql: `SELECT id, supplier_id, draft_id, event_type, event_time, meta FROM email_event`,
  },
  {
    name: 'unsubscribe_list',
    columns: ['id', 'email', 'source', 'unsubscribed_at', 'handled_by', 'note'],
    sql: `SELECT id, email, source, unsubscribed_at, handled_by, note FROM unsubscribe_list`,
  },
  {
    name: 'audit_log',
    columns: ['id', 'username', 'action', 'object', 'object_id', 'detail', 'created_at'],
    sql: `SELECT id, username, action, object, object_id, detail, created_at FROM audit_log`,
  },
  {
    name: 'import_log',
    columns: ['id', 'batch_id', 'username', 'file_name', 'source_note', 'default_country', 'default_language',
      'dedupe_strategy', 'total_rows', 'success_rows', 'updated_rows', 'skipped_rows', 'failed_rows', 'created_at'],
    sql: `SELECT id, batch_id, username, file_name, source_note, default_country, default_language,
      dedupe_strategy, total_rows, success_rows, updated_rows, skipped_rows, failed_rows, created_at FROM import_log`,
  },
  {
    name: 'export_log',
    columns: ['id', 'username', 'filters', 'fields', 'row_count', 'created_at'],
    sql: `SELECT id, username, filters, fields, row_count, created_at FROM export_log`,
  },
  {
    name: 'user',
    columns: ['id', 'username', 'role', 'status', 'created_at'],
    sql: `SELECT id, username, role, status, created_at FROM lma_user`,
  },
]

/** 生成全量 xlsx（多 sheet）Buffer；exceljs 未安装时抛错提示 */
export async function buildBackupXlsx(db: Db, includeAudit: boolean): Promise<Buffer> {
  let ExcelJS: any
  try {
    ExcelJS = (await import('exceljs')).default
  } catch {
    throw new Error('未安装 exceljs，请在 lma-plugin 目录执行：npm install exceljs --no-save')
  }
  const wb = new ExcelJS.Workbook()
  for (const sheet of SHEETS) {
    if (sheet.name === 'audit_log' && !includeAudit) continue
    const ws = wb.addWorksheet(sheet.name)
    ws.columns = sheet.columns.map((h) => ({ header: h, key: h, width: 18 }))
    const rows = db.prepare(sheet.sql).all() as Array<Record<string, unknown>>
    ws.addRows(rows.map((r) => sheet.columns.map((c) => {
      const v = r[c]
      if (v === null || v === undefined) return ''
      if (typeof v === 'object') return JSON.stringify(v)
      return v
    })))
    ws.getRow(1).font = { bold: true }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 备份摘要（邮件正文） */
export function backupSummary(db: Db): string {
  const c = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
  const sent = c('email_event') // 事件总数（含 sent/replied/bounced…）
  const byType = (db.prepare(`SELECT event_type, COUNT(*) AS n FROM email_event GROUP BY event_type`).all() as Array<{ event_type: string; n: number }>)
    .map((r) => `${r.event_type}: ${r.n}`).join('，') || '无'
  const unsub = c('unsubscribe_list')
  const drafts = (db.prepare(`SELECT status, COUNT(*) AS n FROM email_draft GROUP BY status`).all() as Array<{ status: string; n: number }>)
    .map((r) => `${r.status}: ${r.n}`).join('，') || '无'
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  return [
    `LMA 物流推广系统 · 数据备份`,
    `备份时间：${now}`,
    ``,
    `供应商：${c('supplier')} 条`,
    `邮件草稿（按状态）：${drafts}`,
    `邮件事件（${sent} 条）：${byType}`,
    `退订名单：${unsub} 条`,
    `审计日志：${c('audit_log')} 条`,
    `导入记录：${c('import_log')} 条 · 导出记录：${c('export_log')} 条`,
    ``,
    `详见附件 lma-backup.xlsx（多 sheet 全量数据；user 表不含密码哈希）。`,
  ].join('\n')
}

/** 是否到点运行（服务器本地时间；当天只跑一次） */
export function shouldRunBackup(cfg: BackupConfig, now: Date): boolean {
  if (!cfg.enabled || !cfg.to.trim()) return false
  if (now.getHours() !== cfg.hour || now.getMinutes() !== cfg.minute) return false
  if (cfg.schedule === 'weekly' && now.getDay() !== 0) return false
  if (cfg.schedule === 'monthly' && now.getDate() !== 1) return false
  const last = cfg.lastRunAt ?? ''
  return last.slice(0, 10) !== now.toISOString().slice(0, 10)
}

/** 生成并发送备份邮件；成功更新 lastRunAt / lastResult，写审计 */
export async function runBackupAndSend(db: Db, operator: string): Promise<{ ok: boolean; message: string; to: string }> {
  const cfg = getBackupConfig(db)
  if (!cfg.to.trim()) throw new Error('未配置备份收件邮箱')
  try {
    const xlsx = await buildBackupXlsx(db, cfg.includeAudit)
    const subject = `[LMA] 数据备份 ${new Date().toISOString().slice(0, 10)}`
    const text = backupSummary(db)
    const smtp = getSmtpConfig(db)
    const from = cfg.from?.trim() || smtp.from || ''
    const res = await sendRawMail(db, cfg.to.trim(), subject, text, [
      { filename: `lma-backup-${new Date().toISOString().slice(0, 10)}.xlsx`, content: xlsx, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ])
    const next = { ...cfg, lastRunAt: new Date().toISOString(), lastResult: `ok mode=${res.mode}` }
    saveBackupConfig(db, next, operator)
    audit(db, operator, 'backup_send', 'backup_config', null, { to: cfg.to.trim(), from, mode: res.mode, size: xlsx.length, messageId: res.messageId }, { ip: '', ua: '', sessionId: '' })
    return { ok: true, message: `备份已发送（${res.mode}${res.messageId ? ', messageId=' + res.messageId : ''}）`, to: cfg.to.trim(), mode: res.mode }
  } catch (e) {
    const next = { ...cfg, lastRunAt: new Date().toISOString(), lastResult: `error: ${(e as Error).message}` }
    saveBackupConfig(db, next, operator)
    audit(db, operator, 'backup_send', 'backup_config', null, { to: cfg.to.trim(), error: (e as Error).message }, { ip: '', ua: '', sessionId: '' })
    throw e
  }
}

// 统一入库管道（PRD 4.2/5.2）：字段映射 → 校验 → 规范化 → 去重 → 入库 → 日志
// 适配 WCA 导出模板：emails（分号多邮箱）、networks、profile 长文本、address/fax/enrolled_since
import crypto from 'node:crypto'
import type { Db } from './db.ts'
import { collapseSpaces, isValidEmail, normHeader, splitMulti } from './util.ts'
import { countryToTimezone, normalizeLanguage } from './timezone.ts'

export const STANDARD_FIELDS = [
  'company_name', 'email', 'contact_name', 'phone', 'fax', 'website', 'business', 'networks',
  'profile', 'country', 'region', 'address', 'preferred_language', 'external_id', 'enrolled_since',
]

export const FIELD_LABELS: Record<string, string> = {
  company_name: '公司名称', email: '邮箱', contact_name: '联系人', phone: '电话', fax: '传真',
  website: '官网', business: '主营业务', networks: '会员网络', profile: '公司介绍', country: '国家',
  region: '地区/城市', address: '地址', preferred_language: '首选语言', external_id: '外部ID',
  enrolled_since: '入会时间',
}

const FIELD_ALIASES: Record<string, string[]> = {
  company_name: ['company', 'companyname', 'company_name', '公司', '公司名称', '企业名称', '企业'],
  email: ['emails', 'email', 'e-mail', 'mail', 'emailaddress', '邮箱', '电子邮箱', '邮箱地址'],
  contact_name: ['contacts', 'contact', 'contactperson', 'contact_person', 'contactname', 'name', '联系人', '负责人', '姓名'],
  phone: ['phone', 'tel', 'telephone', 'mobile', '电话', '手机', '手机号', '联系电话'],
  fax: ['fax', '传真'],
  website: ['website', 'web', 'site', 'url', 'websiteurl', '官网', '网址'],
  business: ['business', 'businesstype', 'business_type', 'industry', '主营业务', '业务', '行业', '经营范围'],
  networks: ['networks', 'network', 'wca', '会员网络', '网络'],
  profile: ['profile', 'description', 'intro', 'about', 'company_intro', '公司介绍', '简介', '介绍'],
  country: ['country', '国家', '所在国家', '国籍'],
  region: ['region', 'city', 'state', 'province', '地区', '城市', '省份'],
  address: ['address', 'addr', '地址'],
  preferred_language: ['language', 'lang', '首选语言', '语言', '语种'],
  external_id: ['id', 'external_id', 'source_id'],
  enrolled_since: ['enrolled_since', 'enrolled', '入会时间', '加入时间'],
}

export type Mapping = Record<string, number | null>

export function autoMapColumns(columns: string[]): Mapping {
  const mapping: Mapping = {}
  for (const f of STANDARD_FIELDS) mapping[f] = null
  const used = new Set<string>()
  columns.forEach((raw, idx) => {
    const h = normHeader(raw)
    if (!h) return
    for (const f of STANDARD_FIELDS) {
      if (used.has(f)) continue
      if (FIELD_ALIASES[f].includes(h)) {
        mapping[f] = idx
        used.add(f)
        return
      }
    }
  })
  return mapping
}

export function getCell(row: string[], idx: number | null): string {
  if (idx === null || idx === undefined) return ''
  const v = row[idx]
  return v === null || v === undefined ? '' : String(v).trim()
}

export interface RowIssue {
  row: number
  reason: string
}

export interface ImportReport {
  batchId: string
  totalRows: number
  successRows: number
  updatedRows: number
  skippedRows: number
  failedRows: number
  failures: RowIssue[]
}

export interface PreviewResult {
  stats: { total: number; valid: number; invalid: number; duplicate: number }
  preview: Array<{ row: number; data: Record<string, string>; errors: string[]; warn: string | null; duplicate: boolean }>
}

// ---------- 校验单行 ----------
export function validateRow(row: string[], mapping: Mapping, defaultCountry: string): { errors: string[]; warn: string | null; email: string; company: string } {
  const errors: string[] = []
  // emails 可能为分号分隔的多邮箱（WCA 模板），取第一个为主邮箱
  const email = splitMulti(getCell(row, mapping.email))[0] ?? ''
  if (!email) errors.push('邮箱缺失')
  else if (!isValidEmail(email)) errors.push('邮箱格式错误')
  const company = getCell(row, mapping.company_name)
  if (!company) errors.push('公司名称缺失')
  const country = getCell(row, mapping.country)
  let warn: string | null = null
  if (!country && !defaultCountry) warn = '国家缺失（可在导入时指定默认国家填充）'
  return { errors, warn, email: email.toLowerCase(), company }
}

// ---------- 规范化单行（确认导入阶段，含默认值填充与时区推断） ----------
export function normalizeRow(row: string[], mapping: Mapping, defaults: { defaultCountry?: string; defaultLanguage?: string }): Record<string, unknown> {
  const emails = splitMulti(getCell(row, mapping.email))
  const primary = emails.shift() ?? ''
  const out: Record<string, unknown> = {
    company_name: collapseSpaces(getCell(row, mapping.company_name)),
    email: primary.toLowerCase(),
    extra_emails: emails.length ? JSON.stringify(emails) : null,
    contact_name: collapseSpaces(getCell(row, mapping.contact_name)),
    phone: collapseSpaces(getCell(row, mapping.phone)),
    fax: collapseSpaces(getCell(row, mapping.fax)),
    external_id: collapseSpaces(getCell(row, mapping.external_id)) || null,
    enrolled_since: collapseSpaces(getCell(row, mapping.enrolled_since)) || null,
  }
  let website = getCell(row, mapping.website)
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website
  out.website = website
  out.business = collapseSpaces(getCell(row, mapping.business))
  out.networks = collapseSpaces(getCell(row, mapping.networks))
  out.profile = collapseSpaces(getCell(row, mapping.profile))
  out.address = collapseSpaces(getCell(row, mapping.address))

  const rawCountry = getCell(row, mapping.country) || defaults.defaultCountry || ''
  const ct = countryToTimezone(rawCountry)
  out.country = ct ? ct.country : (rawCountry ? rawCountry.toUpperCase().slice(0, 2) : '')
  out.timezone = ct ? ct.timezone : null

  out.region = collapseSpaces(getCell(row, mapping.region))
  out.preferred_language = normalizeLanguage(getCell(row, mapping.preferred_language))
    ?? normalizeLanguage(defaults.defaultLanguage) ?? 'en'
  return out
}

// ---------- 预览（导入前）：合法/异常/重复统计 + 前 N 行 ----------
export function previewRows(rows: string[][], mapping: Mapping, db: Db, defaultCountry = ''): PreviewResult {
  const stats = { total: rows.length, valid: 0, invalid: 0, duplicate: 0 }
  const preview: PreviewResult['preview'] = []
  const dbEmails = new Set(
    (db.prepare('SELECT email FROM supplier WHERE deleted_at IS NULL').all() as Array<{ email: string }>).map((r) => r.email),
  )
  const fileSeen = new Set<string>()
  rows.forEach((row, i) => {
    const { errors, warn, email } = validateRow(row, mapping, defaultCountry)
    const dup = fileSeen.has(email) || dbEmails.has(email)
    if (errors.length) stats.invalid++
    else stats.valid++
    if (dup) stats.duplicate++
    fileSeen.add(email)
    if (preview.length < 15) {
      const data: Record<string, string> = {}
      for (const f of STANDARD_FIELDS) data[f] = getCell(row, mapping[f])
      preview.push({ row: i + 2, data, errors, warn, duplicate: dup })
    }
  })
  return { stats, preview }
}

export function makeBatchId(): string {
  return crypto.randomUUID()
}

// ---------- 确认导入执行（事务分批，返回报告） ----------
export function executeImport(
  db: Db,
  args: {
    batchId: string
    rows: string[][]
    mapping: Mapping
    strategy: 'skip' | 'update' | 'create'
    sourceNote: string
    defaultCountry?: string
    defaultLanguage?: string
    username: string
  },
): ImportReport {
  const { batchId, rows, mapping, strategy, sourceNote, defaultCountry, defaultLanguage, username } = args
  if (!sourceNote?.trim()) {
    throw new Error('必须填写数据来源备注（合规溯源要求，F-CSV-07）')
  }
  const defaults = { defaultCountry, defaultLanguage }

  const findDup = db.prepare('SELECT id, company_name FROM supplier WHERE email = ? AND deleted_at IS NULL ORDER BY id LIMIT 1')
  const insertStmt = db.prepare(
    `INSERT INTO supplier
      (company_name, contact_name, email, extra_emails, phone, fax, website, business, networks, profile,
       address, country, timezone, region, preferred_language, external_id, enrolled_since,
       source, import_batch_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
  const updateStmt = db.prepare(
    `UPDATE supplier SET company_name = ?, contact_name = ?, email = ?, extra_emails = ?, phone = ?, fax = ?,
       website = ?, business = ?, networks = ?, profile = ?, address = ?, country = ?, timezone = ?,
       region = ?, preferred_language = ?, external_id = ?, enrolled_since = ?,
       source = ?, import_batch_id = ?, updated_at = datetime('now') WHERE id = ?`,
  )

  let success = 0, updated = 0, skipped = 0, failed = 0
  const failures: RowIssue[] = []
  const seenEmails = new Set<string>()

  const insert = (n: Record<string, unknown>) => {
    insertStmt.run(
      n.company_name, n.contact_name, n.email, n.extra_emails, n.phone, n.fax, n.website,
      n.business, n.networks, n.profile, n.address, n.country, n.timezone, n.region,
      n.preferred_language, n.external_id, n.enrolled_since, sourceNote.trim(), batchId,
    )
  }

  db.exec('BEGIN')
  try {
    rows.forEach((row, i) => {
      const base = normalizeRow(row, mapping, defaults)
      const reason: string[] = []
      if (!base.email || !isValidEmail(base.email)) reason.push('邮箱缺失或格式错误')
      if (!base.company_name) reason.push('公司名称缺失')
      if (!base.country) reason.push('国家缺失且未指定默认国家')
      if (reason.length) {
        failed++
        if (failures.length < 2000) failures.push({ row: i + 2, reason: reason.join('；') })
        return
      }

      const dup = findDup.get(base.email) as { id: number; company_name: string } | undefined
      const dupFile = seenEmails.has(base.email as string)
      if (dup || dupFile) {
        if (strategy === 'skip') { skipped++; return }
        if (strategy === 'update' && dup) {
          updateStmt.run(
            base.company_name, base.contact_name, base.email, base.extra_emails, base.phone, base.fax,
            base.website, base.business, base.networks, base.profile, base.address, base.country,
            base.timezone, base.region, base.preferred_language, base.external_id, base.enrolled_since,
            sourceNote.trim(), batchId, dup.id,
          )
          updated++
          return
        }
        if (dup && dup.company_name === base.company_name) { skipped++; return }
      }
      insert(base)
      success++
      seenEmails.add(base.email as string)
    })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  // 导入日志
  db.prepare(
    `INSERT INTO import_log (batch_id, username, file_name, source_note, default_country, default_language,
       dedupe_strategy, total_rows, success_rows, updated_rows, skipped_rows, failed_rows, fail_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    batchId, username, 'csv-import', sourceNote.trim(), defaultCountry ?? '', defaultLanguage ?? '',
    strategy, rows.length, success, updated, skipped, failed, JSON.stringify(failures.slice(0, 2000)),
  )
  return {
    batchId, totalRows: rows.length, successRows: success, updatedRows: updated,
    skippedRows: skipped, failedRows: failed, failures: failures.slice(0, 2000),
  }
}

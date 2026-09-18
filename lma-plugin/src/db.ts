// LMA 数据库：node:sqlite（内置，零原生依赖），WAL，迁移，配置读写
// 数据模型对齐 PRD 第七章 + 二开新增字段（address/fax/networks/profile/extra_emails 等，适配 WCA 导出模板）
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

const MIGRATIONS: string[] = [
  // 认证与会话（二开中保留：账号体系仍按 PRD 的 admin/staff 设计）
  `
  CREATE TABLE IF NOT EXISTS lma_user (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin','staff')),
    status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_login_at TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL DEFAULT 'system',
    action     TEXT    NOT NULL,
    object     TEXT,
    object_id  INTEGER,
    detail     TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
  `,
  // 供应商主表（PRD 第七章 + WCA 模板扩展字段）
  `
  CREATE TABLE IF NOT EXISTS supplier (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id        TEXT,
    company_name       TEXT    NOT NULL,
    contact_name       TEXT,
    email              TEXT    NOT NULL,
    extra_emails       TEXT,
    phone              TEXT,
    fax                TEXT,
    website            TEXT,
    business           TEXT,
    networks           TEXT,
    profile            TEXT,
    address            TEXT,
    country            TEXT,
    timezone           TEXT,
    region             TEXT,
    preferred_language TEXT,
    enrolled_since     TEXT,
    source             TEXT    NOT NULL DEFAULT '',
    import_batch_id    TEXT,
    match_score        REAL,
    match_analysis     TEXT,
    status             TEXT    NOT NULL DEFAULT 'new'
      CHECK (status IN ('new','matched','drafted','approved','sent',
                        'replied','follow_up','unsubscribed','invalid')),
    last_contact_at    TEXT,
    replied_at         TEXT,
    follow_up_count    INTEGER NOT NULL DEFAULT 0,
    deleted_at         TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_email_company_active
    ON supplier(email, company_name) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_supplier_country ON supplier(country);
  CREATE INDEX IF NOT EXISTS idx_supplier_status  ON supplier(status);
  CREATE INDEX IF NOT EXISTS idx_supplier_batch   ON supplier(import_batch_id);
  `,
  // 导入 / 导出日志
  `
  CREATE TABLE IF NOT EXISTS import_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id         TEXT    NOT NULL UNIQUE,
    username         TEXT    NOT NULL,
    file_name        TEXT    NOT NULL,
    source_note      TEXT,
    default_country  TEXT,
    default_language TEXT,
    dedupe_strategy  TEXT,
    total_rows       INTEGER NOT NULL,
    success_rows     INTEGER NOT NULL,
    updated_rows     INTEGER NOT NULL DEFAULT 0,
    skipped_rows     INTEGER NOT NULL,
    failed_rows      INTEGER NOT NULL,
    fail_detail      TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS export_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL,
    filters    TEXT,
    fields     TEXT,
    row_count  INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 邮件草稿 / 事件 / 退订
  `
  CREATE TABLE IF NOT EXISTS email_draft (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id    INTEGER NOT NULL REFERENCES supplier(id),
    subject        TEXT NOT NULL,
    body           TEXT NOT NULL,
    language       TEXT NOT NULL DEFAULT 'en',
    match_analysis TEXT,
    match_score    REAL,
    status         TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','approved','rejected')),
    reject_reason  TEXT,
    reviewer       TEXT,
    reviewed_at    TEXT,
    created_by     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_draft_status ON email_draft(status, created_at);

  CREATE TABLE IF NOT EXISTS email_event (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES supplier(id),
    draft_id    INTEGER REFERENCES email_draft(id),
    event_type  TEXT NOT NULL CHECK
      (event_type IN ('sent','delivered','replied','bounced','unsubscribed')),
    event_time  TEXT NOT NULL DEFAULT (datetime('now')),
    meta        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_event_supplier ON email_event(supplier_id, event_time);

  CREATE TABLE IF NOT EXISTS unsubscribe_list (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT NOT NULL UNIQUE,
    source          TEXT NOT NULL,
    unsubscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
    handled_by      TEXT,
    note            TEXT
  );
  `,
  // 会话与登录限流（多用户改造）
  `
  CREATE TABLE IF NOT EXISTS lma_session (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES lma_user(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    ip         TEXT,
    ua         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_user    ON lma_session(user_id);
  CREATE INDEX IF NOT EXISTS idx_session_expires ON lma_session(expires_at);

  CREATE TABLE IF NOT EXISTS login_attempt (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    NOT NULL,
    ip       TEXT    NOT NULL DEFAULT '',
    at       TEXT    NOT NULL DEFAULT (datetime('now')),
    ok       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempt ON login_attempt(username, ip, at);
  `,
  // 系统配置（业务画像/邮件模板/发送策略，JSON）
  `
  CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  );
  `,
]

/** CREATE TABLE IF NOT EXISTS 不会给已存在的表加列；ALTER 前先查表结构，保证迁移幂等 */
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  for (const sql of MIGRATIONS) db.exec(sql)
  // 给已存在的库补列（迁移幂等；新库在上面建表时已含这些列）
  ensureColumn(db, 'lma_user', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'lma_user', 'last_login_at', 'TEXT')
  ensureColumn(db, 'audit_log', 'ip', 'TEXT')
  ensureColumn(db, 'audit_log', 'ua', 'TEXT')
  ensureColumn(db, 'audit_log', 'session_id', 'TEXT')
  ensureColumn(db, 'audit_log', 'result', "TEXT NOT NULL DEFAULT 'ok'")
  return db
}

// ---------- 配置读写（app_config，JSON 值） ----------
export function getConfig<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value?: string } | undefined
  if (!row?.value) return fallback
  try { return JSON.parse(row.value) as T } catch { return fallback }
}

export function setConfig(db: Db, key: string, value: unknown, by?: string): void {
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).run(key, JSON.stringify(value), by ?? null)
}

// ---------- 默认配置 ----------
export interface ProfileConfig {
  companyName: string
  intro: string
  services: string[]
  strengths: string[]
  targetMarkets: string[]
}

export interface EmailTemplateConfig {
  footerSource: string
  bannedWords: string[]
  subjectMax: number
  bodyMaxWords: number
  ctaHint: string
}

export interface SendPolicyConfig {
  intervalMinutes: number
  dailyLimit: number
  checkWorkingHours: boolean
  workStart: number
  workEnd: number
  autoFollowup: boolean
  followupAfterDays: number
  followupMax: number
}

export const TRANSTAR_PROFILE: ProfileConfig = {
  companyName: 'Shanghai Transtar International Freight Forwarding Co., Ltd.',
  intro:
    'Established in 2022, Shanghai Transtar is a leading integrated logistics provider headquartered in Shanghai, China, with branch networks across major global trade hubs. We specialize in end-to-end supply chain solutions, leveraging China\'s key ports (Shanghai, Ningbo, Shenzhen) and bonded warehouse facilities to deliver seamless cross-border logistics services.',
  services: [
    'Customs Clearance & Compliance (cross-border e-commerce clearance)',
    'Multimodal Transport: Air/ocean freight, rail (China-Europe Express), barge',
    'Bonded & Smart Warehousing: 50,000㎡ with RFID tracking',
    'Consolidation: LCL/FCL for cost-sensitive shipments',
    'Project Logistics: heavy-lift and oversize cargo',
    'Door-to-Door Delivery: DDP/DDU/EXW with real-time tracking',
    'Cold Chain & ISO Tank Solutions',
    'Trade Consultation: Incoterms optimization and duty savings',
  ],
  strengths: [
    'Localized expertise in China logistics and port operations',
    'Cost efficiency: negotiated rates with 100+ global carriers (COSCO, Maersk)',
    'Technology-driven: AI-powered TMS for route optimization and carbon reduction',
    'Customer-centric: 24/7 bilingual support and tailored SOPs for MNCs/SMEs',
  ],
  targetMarkets: ['NL', 'DE', 'GB', 'US', 'AU', 'SG', 'FR', 'BE', 'IT', 'ES'],
}

export const DEFAULT_EMAIL_TEMPLATE: EmailTemplateConfig = {
  footerSource:
    'You are receiving this email because your company was identified as a potential business partner (source: {source}). If you prefer not to receive further messages, please unsubscribe.',
  bannedWords: ['guarantee', '100%', 'free', 'cheapest', 'no.1', 'best', '促销', '免费', '最低价'],
  subjectMax: 80,
  bodyMaxWords: 250,
  ctaHint: '邮件必须包含一个明确 CTA（如：回复本邮件 / 预约 15 分钟沟通）',
}

export const DEFAULT_SEND_POLICY: SendPolicyConfig = {
  intervalMinutes: 3,
  dailyLimit: 20,
  checkWorkingHours: true,
  workStart: 9,
  workEnd: 18,
  autoFollowup: false,
  followupAfterDays: 3,
  followupMax: 2,
}

export function getProfile(db: Db): ProfileConfig {
  return { ...TRANSTAR_PROFILE, ...getConfig<Partial<ProfileConfig>>(db, 'profile', {}) }
}

export function getEmailTemplate(db: Db): EmailTemplateConfig {
  return { ...DEFAULT_EMAIL_TEMPLATE, ...getConfig<Partial<EmailTemplateConfig>>(db, 'email_template', {}) }
}

export function getSendPolicy(db: Db): SendPolicyConfig {
  return { ...DEFAULT_SEND_POLICY, ...getConfig<Partial<SendPolicyConfig>>(db, 'send_policy', {}) }
}

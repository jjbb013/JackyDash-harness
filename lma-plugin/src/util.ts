// LMA 通用工具：哈希、CSV 转义、邮箱校验、文本规范化
import crypto from 'node:crypto'

export const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function hmac(secret: string, s: string): string {
  return crypto.createHmac('sha256', secret).update(s).digest('hex')
}

// ---------- 密码哈希（scrypt，Node 内置） ----------
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [, saltHex, hashHex] = String(stored).split('$')
    if (!saltHex || !hashHex) return false
    const salt = Buffer.from(saltHex, 'hex')
    const expect = Buffer.from(hashHex, 'hex')
    const actual = crypto.scryptSync(password, salt, expect.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    return crypto.timingSafeEqual(actual, expect)
  } catch {
    return false
  }
}

// ---------- 邮箱 ----------
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && EMAIL_RE.test(s.trim()) && s.trim().length <= 254
}

// ---------- CSV 转义（RFC 4180） ----------
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function csvLine(row: unknown[]): string {
  return row.map(csvCell).join(',')
}

// ---------- 文本规范化 ----------
export function collapseSpaces(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

export function normHeader(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[\s\-_.()（）【】[\]]+/g, '')
}

// 分号分隔的多值 → 数组（CSV 模板 emails/networks 用）
export function splitMulti(s: unknown, sep = ';'): string[] {
  if (!s) return []
  return String(s).split(sep).map((x) => x.trim()).filter(Boolean)
}

export function maskSecret(v: string): string {
  if (!v) return ''
  if (v.length <= 4) return '****'
  return v.slice(0, 2) + '****' + v.slice(-2)
}

// 从字符串里提取邮箱（IMAP 回复头用）
export function extractEmail(s: unknown): string | null {
  if (!s) return null
  const m = String(s).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)
  return m ? m[0].toLowerCase() : null
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

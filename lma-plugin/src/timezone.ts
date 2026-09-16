// 时区与国家/语言规范化（PRD F-CSV-08/09、F-DATA-02、F-SEND-06）
export const COUNTRY_TIMEZONE: Record<string, string> = {
  NZ: 'Pacific/Auckland',   AU: 'Australia/Sydney', SG: 'Asia/Singapore',
  CN: 'Asia/Shanghai',      HK: 'Asia/Hong_Kong',   TW: 'Asia/Taipei',
  JP: 'Asia/Tokyo',         KR: 'Asia/Seoul',       IN: 'Asia/Kolkata',
  AE: 'Asia/Dubai',         TH: 'Asia/Bangkok',     VN: 'Asia/Ho_Chi_Minh',
  MY: 'Asia/Kuala_Lumpur',  ID: 'Asia/Jakarta',     PH: 'Asia/Manila',
  GB: 'Europe/London',      DE: 'Europe/Berlin',    FR: 'Europe/Paris',
  NL: 'Europe/Amsterdam',   BE: 'Europe/Brussels',  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',      PL: 'Europe/Warsaw',    SE: 'Europe/Stockholm',
  CH: 'Europe/Zurich',      IE: 'Europe/Dublin',    PT: 'Europe/Lisbon',
  US: 'America/New_York',   CA: 'America/Toronto',  MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo',  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',   CO: 'America/Bogota',   PE: 'America/Lima',
  TR: 'Europe/Istanbul',    IL: 'Asia/Jerusalem',   SA: 'Asia/Riyadh',
  EG: 'Africa/Cairo',       ZA: 'Africa/Johannesburg', NG: 'Africa/Lagos',
  RU: 'Europe/Moscow',      UA: 'Europe/Kyiv',      CZ: 'Europe/Prague',
  AT: 'Europe/Vienna',      DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki',
  NO: 'Europe/Oslo',        GR: 'Europe/Athens',    RO: 'Europe/Bucharest',
}

export const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'new zealand': 'NZ', 'nz': 'NZ', '新西兰': 'NZ',
  'australia': 'AU', 'australian': 'AU', '澳大利亚': 'AU',
  'singapore': 'SG', '新加坡': 'SG',
  'china': 'CN', 'mainland china': 'CN', '中国': 'CN', '中国大陆': 'CN',
  'hong kong': 'HK', 'hongkong': 'HK', '香港': 'HK',
  'taiwan': 'TW', '台湾': 'TW',
  'japan': 'JP', '日本': 'JP',
  'south korea': 'KR', 'korea': 'KR', '韩国': 'KR',
  'india': 'IN', '印度': 'IN',
  'united arab emirates': 'AE', 'uae': 'AE', '阿联酋': 'AE', '迪拜': 'AE', 'dubai': 'AE',
  'thailand': 'TH', '泰国': 'TH',
  'vietnam': 'VN', '越南': 'VN',
  'malaysia': 'MY', '马来西亚': 'MY',
  'indonesia': 'ID', '印度尼西亚': 'ID', '印尼': 'ID',
  'philippines': 'PH', '菲律宾': 'PH',
  'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB', 'england': 'GB', '英国': 'GB',
  'germany': 'DE', '德国': 'DE',
  'france': 'FR', '法国': 'FR',
  'netherlands': 'NL', 'holland': 'NL', '荷兰': 'NL',
  'belgium': 'BE', '比利时': 'BE',
  'italy': 'IT', '意大利': 'IT',
  'spain': 'ES', '西班牙': 'ES',
  'poland': 'PL', '波兰': 'PL',
  'sweden': 'SE', '瑞典': 'SE',
  'switzerland': 'CH', '瑞士': 'CH',
  'ireland': 'IE', '爱尔兰': 'IE',
  'portugal': 'PT', '葡萄牙': 'PT',
  'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US', '美国': 'US',
  'canada': 'CA', '加拿大': 'CA',
  'mexico': 'MX', '墨西哥': 'MX',
  'brazil': 'BR', '巴西': 'BR',
  'argentina': 'AR', '阿根廷': 'AR',
  'chile': 'CL', '智利': 'CL',
  'colombia': 'CO', '哥伦比亚': 'CO',
  'peru': 'PE', '秘鲁': 'PE',
  'turkey': 'TR', 'turkiye': 'TR', '土耳其': 'TR',
  'israel': 'IL', '以色列': 'IL',
  'saudi arabia': 'SA', '沙特': 'SA', '沙特阿拉伯': 'SA',
  'egypt': 'EG', '埃及': 'EG',
  'south africa': 'ZA', '南非': 'ZA',
  'nigeria': 'NG', '尼日利亚': 'NG',
  'russia': 'RU', '俄罗斯': 'RU',
  'ukraine': 'UA', '乌克兰': 'UA',
  'czech republic': 'CZ', 'czechia': 'CZ', '捷克': 'CZ',
  'austria': 'AT', '奥地利': 'AT',
  'denmark': 'DK', '丹麦': 'DK',
  'finland': 'FI', '芬兰': 'FI',
  'norway': 'NO', '挪威': 'NO',
  'greece': 'GR', '希腊': 'GR',
  'romania': 'RO', '罗马尼亚': 'RO',
}

export const LANG_TO_CODE: Record<string, string> = {
  english: 'en', en: 'en', 英语: 'en',
  chinese: 'zh', zh: 'zh', 'zh-cn': 'zh', 中文: 'zh', 简体中文: 'zh',
  german: 'de', de: 'de', 德语: 'de',
  french: 'fr', fr: 'fr', 法语: 'fr',
  japanese: 'ja', ja: 'ja', 日语: 'ja',
  korean: 'ko', ko: 'ko', 韩语: 'ko',
  spanish: 'es', es: 'es', 西班牙语: 'es',
  dutch: 'nl', nl: 'nl', 荷兰语: 'nl',
  italian: 'it', it: 'it', 意大利语: 'it',
  portuguese: 'pt', pt: 'pt', 葡萄牙语: 'pt',
  russian: 'ru', ru: 'ru', 俄语: 'ru',
  vietnamese: 'vi', vi: 'vi', 越南语: 'vi',
  thai: 'th', th: 'th', 泰语: 'th',
  indonesian: 'id', id: 'id', 印尼语: 'id',
  arabic: 'ar', ar: 'ar', 阿拉伯语: 'ar',
}

export function countryToTimezone(input: unknown): { country: string; timezone: string } | null {
  if (!input) return null
  const s = String(input).trim()
  const code = COUNTRY_NAME_TO_CODE[s.toLowerCase()] ?? s.toUpperCase().slice(0, 2)
  const tz = COUNTRY_TIMEZONE[code]
  return tz ? { country: code, timezone: tz } : null
}

export function normalizeLanguage(input: unknown): string | null {
  if (!input) return null
  const s = String(input).trim().toLowerCase()
  return LANG_TO_CODE[s] ?? s.slice(0, 2)
}

// ---------- 时区当地时间 ----------
const PARTS_CACHE = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = PARTS_CACHE.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
    })
    PARTS_CACHE.set(tz, f)
  }
  return f
}

export interface TzParts { y: number; m: number; d: number; wd: number; hh: number; mm: number; local: string }

export function tzParts(tz: string, date = new Date()): TzParts {
  const parts: Record<string, string> = {}
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const wdMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    wd: wdMap[parts.weekday] ?? 0,
    hh: +parts.hour, mm: +parts.minute,
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
  }
}

export function tzOffsetMs(tz: string, date = new Date()): number {
  const p = tzParts(tz, date)
  const utcGuess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm)
  const diff = utcGuess - date.getTime()
  return diff - (diff % 3600000) + (Math.abs(diff % 3600000) > 30 * 60000 ? 3600000 : 0)
}

export function formatOffset(ms: number): string {
  const sign = ms >= 0 ? '+' : '-'
  const abs = Math.abs(ms) / 60000
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

export function localTimeString(tz: string | null, date = new Date()): string | null {
  if (!tz) return null
  try {
    const p = tzParts(tz, date)
    return `${p.local} (UTC${formatOffset(tzOffsetMs(tz, date))})`
  } catch {
    return null
  }
}

// ---------- 工作时段（F-SEND-06） ----------
export function isWorkingTime(tz: string | null, workStart = 9, workEnd = 18, date = new Date()): boolean {
  if (!tz) return true
  const p = tzParts(tz, date)
  if (p.wd >= 6) return false
  return p.hh >= workStart && p.hh < workEnd
}

export function nextWorkStartMs(tz: string | null, workStart = 9, date = new Date()): number {
  if (!tz) return date.getTime() + 3600_000
  const tzOff = tzOffsetMs(tz, date)
  for (let i = 1; i <= 8; i++) {
    const target = new Date(date.getTime() + i * 86_400_000)
    const p = tzParts(tz, target)
    if (p.wd <= 5) {
      const utcTarget = Date.UTC(p.y, p.m - 1, p.d, workStart, 0) - tzOff
      if (utcTarget > date.getTime()) return utcTarget
    }
  }
  return date.getTime() + 86_400_000
}

// 密码哈希（F-AUTH-02）：node:crypto 的**异步** scrypt —— 零原生依赖，走 libuv 线程池不阻塞事件循环。
//
// 存储格式自描述，便于将来提升参数后"登录成功时自动 rehash"：
//   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
// 兼容历史格式（util.ts 早期版本）：s1$<saltHex>$<hashHex>（固定 N=16384/r=8/p=1/keylen=64）
import crypto from 'node:crypto'

export interface ScryptParams { N: number; r: number; p: number; keylen: number }

/**
 * 默认参数 N=2^16：内存 = 128 * N * r ≈ 64 MiB，2G 小 VPS 上单次登录约 100~300 ms。
 * OWASP 推荐 N=2^17（128 MiB），可用 LMA_SCRYPT_N=131072 提高，代价是并发登录时内存翻倍。
 *
 * ⚠️ 坑：Node 的 scrypt **默认 maxmem 只有 32 MiB**，N=2^16 就已经超过，
 * 必须显式传 maxmem，否则抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
 */
export const DEFAULT_SCRYPT: ScryptParams = { N: 1 << 16, r: 8, p: 1, keylen: 32 }

const LEGACY: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 64 }

const maxmemFor = (p: ScryptParams): number => 128 * p.N * p.r * 2 // 留 2 倍余量

/** 当前生效参数（LMA_SCRYPT_N 可调，低于 2^14 的值会被忽略以防误配削弱安全） */
export function currentParams(): ScryptParams {
  const raw = Number(process.env.LMA_SCRYPT_N ?? '')
  if (Number.isFinite(raw) && raw >= 1 << 14) return { ...DEFAULT_SCRYPT, N: raw }
  return DEFAULT_SCRYPT
}

function scryptAsync(password: string, salt: Buffer, keylen: number, p: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N: p.N, r: p.r, p: p.p, maxmem: maxmemFor(p) }, (err, derived) => {
      if (err) reject(err)
      else resolve(derived as Buffer)
    })
  })
}

/**
 * 同步版本，**仅用于进程启动时的引导建号**（cordis 的 apply 是同步的）。
 * 其余所有路径一律用异步版，避免阻塞事件循环。
 */
export function hashPasswordSync(password: string, p: ScryptParams = currentParams()): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: maxmemFor(p) })
  return `scrypt$${p.N}$${p.r}$${p.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/** 生成密码哈希 */
export async function hashPassword(password: string, p: ScryptParams = currentParams()): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = await scryptAsync(password, salt, p.keylen, p)
  return `scrypt$${p.N}$${p.r}$${p.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

/**
 * 校验密码。未知/损坏格式一律返回 false，但**仍然消耗一次固定哈希的时间**，
 * 避免通过响应时间枚举"用户名是否存在"。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const s = String(stored ?? '')

  if (s.startsWith('scrypt$')) {
    const parts = s.split('$')
    if (parts.length !== 6) return false
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3])
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N < 1024 || r < 1 || p < 1) return false
    const salt = Buffer.from(parts[4], 'base64')
    const expect = Buffer.from(parts[5], 'base64')
    if (!salt.length || !expect.length) return false
    const actual = await scryptAsync(password, salt, expect.length, { N, r, p, keylen: expect.length })
    return timingSafeEqual(actual, expect)
  }

  if (s.startsWith('s1$')) {
    const [, saltHex, hashHex] = s.split('$')
    if (!saltHex || !hashHex) return false
    const salt = Buffer.from(saltHex, 'hex')
    const expect = Buffer.from(hashHex, 'hex')
    if (!salt.length || !expect.length) return false
    const actual = await scryptAsync(password, salt, expect.length, LEGACY)
    return timingSafeEqual(actual, expect)
  }

  // 未知格式：跑一次等价开销的哈希再返回 false（防时序枚举）
  await scryptAsync(password, Buffer.alloc(16), DEFAULT_SCRYPT.keylen, DEFAULT_SCRYPT)
  return false
}

/** 长度不同直接返回 false；长度相同用 timingSafeEqual 常量时间比较 */
export function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** 存量哈希是否该在登录成功后重算（参数落后于当前配置） */
export function needsRehash(stored: string): boolean {
  const s = String(stored ?? '')
  if (!s.startsWith('scrypt$')) return true // s1$ 历史格式，或未知格式 → 重算
  const [N, r] = s.split('$').slice(1, 3).map(Number)
  const cur = currentParams()
  return N !== cur.N || r !== cur.r
}

/** 一次性初始密码（admin 建号时生成，仅显示一次，不落日志） */
export function generateTempPassword(len = 16): string {
  // 去掉易混淆字符（0/O/1/l/I），便于口头/截图传达
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

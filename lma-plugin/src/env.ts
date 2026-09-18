// 运行环境自适配（F-DEPLOY-01）
//
// 约定：**macOS / Windows 视为本地电脑**（开发者本机，走 127.0.0.1）；
//       **Linux 视为服务器**（VPS 部署，必须配公网域名）。
//
// 为什么要按平台区分：同一份代码要同时跑在开发机和 VPS 上，而"对外地址"决定了三件事——
//   1) 邮件页脚里的退订链接（本地是 http://127.0.0.1:3081，服务器必须是 https://域名）
//   2) Cookie 是否加 Secure、是否用 __Host- 前缀
//   3) 启动日志里打印的访问地址
// 靠平台判断可以在服务器上"忘了配域名"时**大声告警**，而不是静默发出一个点不开的链接。

export type RuntimeEnv = 'local' | 'server'

export const PLATFORM: string = process.platform
/** macOS / Windows = 本地电脑；其余（linux 等）= 服务器 */
export const RUNTIME: RuntimeEnv = PLATFORM === 'darwin' || PLATFORM === 'win32' ? 'local' : 'server'
export const IS_LOCAL: boolean = RUNTIME === 'local'
export const IS_SERVER: boolean = RUNTIME === 'server'

const trimSlash = (s: string): string => s.replace(/\/+$/, '')

/**
 * 对外可访问的站点根地址（不带尾斜杠）。
 * - 本地：默认 `http://127.0.0.1:<port>`
 * - 服务器：必须显式配 `LMA_PUBLIC_URL`（如 `https://lma.example.com`）；
 *   未配时退回 localhost 并返回告警（由 missingServerConfig 负责提示）
 */
export function publicBaseUrl(port = 3081): string {
  const explicit = (process.env.LMA_PUBLIC_URL ?? '').trim()
  if (explicit) return trimSlash(explicit)
  return `http://127.0.0.1:${port}`
}

/**
 * Cookie 是否加 `Secure`。
 * 判定顺序：显式 `LMA_COOKIE_SECURE`（1/true/false/0）> 公网地址是否 https。
 */
export function cookieSecure(): boolean {
  const v = (process.env.LMA_COOKIE_SECURE ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return publicBaseUrl().startsWith('https://')
}

/** 服务器上缺失的关键配置（启动时打印告警，避免"跑起来了但链接是 localhost"的静默错误） */
export function missingServerConfig(): string[] {
  if (!IS_SERVER) return []
  const missing: string[] = []
  if (!(process.env.LMA_PUBLIC_URL ?? '').trim()) missing.push('LMA_PUBLIC_URL')
  return missing
}

/** 启动摘要：一行说清"当前是什么环境、对外地址是什么、有哪些缺失配置" */
export function envSummary(lmaPort: number, chatPort?: number): string {
  const parts = [
    `运行环境=${RUNTIME}（${PLATFORM}）`,
    `对外地址=${publicBaseUrl(lmaPort)}`,
    `CookieSecure=${cookieSecure() ? 'on' : 'off'}`,
  ]
  if (chatPort) parts.push(`聊天UI端口=${chatPort}`)
  const missing = missingServerConfig()
  if (missing.length) parts.push(`⚠️ 服务器环境缺少配置：${missing.join(', ')}（邮件链接与 Cookie 可能不正确）`)
  return parts.join(' · ')
}

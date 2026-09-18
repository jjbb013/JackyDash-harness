// 「进入聊天工作台」入口：把访客从 LMA 登录会话交接到 dsh 聊天 UI（F-AUTH-05）
//
// 为什么需要这一步：dsh web 的浏览器鉴权是**一次性 URL token** —— 只有
// `GET /?token=<token>` 会下发签名 Cookie，之后的请求才认 Cookie；token 只存在于
// dsh 进程内存里。LMA 插件与 dsh 同进程，可以通过公开服务方法
// `ctx.connection.authenticatedUrl()` 拿到带 token 的根地址，于是"登录一次 → 直接
// 进聊天台"不需要任何代理改写，也不需要把 token 写进配置。
//
// 拿不到 connection 服务时（非 web profile，或首帧尚未就绪）退化为不带 token 的根
// 地址：浏览器若已有 dsh 会话 Cookie 仍能进入，否则会看到 dsh 自己的 401 提示，
// 而不是一个"点不动"的死链。
import type { Context } from '@deepseek-ai/cordis'

/** 聊天 UI（dsh web）监听端口。本机开发时它与 LMA 端口（默认 3081）不同，故需显式知道。 */
export const CHAT_PORT = Number(process.env.LMA_CHAT_PORT ?? 3080)

/** dsh 浏览器会话服务：这里只用到"取带一次性 token 的根地址"这一个方法。 */
interface BrowserConnection {
  authenticatedUrl(baseUrl: string): string
}

type Headers = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * 访客实际访问的 origin。反向代理（Caddy/Nginx）会带 `X-Forwarded-Proto` 与
 * `X-Forwarded-Host`，直连时退回 `Host` 与 http。
 * @param headers - 入站请求头。
 * @returns 规范化 origin（如 `https://lma.example.com`）；无法解析时为空串。
 */
export function requestOrigin(headers: Headers): string {
  const host = first(headers['x-forwarded-host']) ?? first(headers['host']) ?? ''
  if (!host) return ''
  const proto = (first(headers['x-forwarded-proto']) ?? 'http').split(',')[0]?.trim() || 'http'
  try {
    return new URL(`${proto}://${host}`).origin
  } catch {
    return ''
  }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 聊天 UI 的 origin。公网部署时它与 LMA 同源（都由同一个域名反代）；本机开发时
 * 两者是同一台机器的不同端口，按 {@link CHAT_PORT} 换端口。
 * @param headers - 入站请求头。
 * @returns 聊天 UI 的 origin；无法解析时为空串。
 */
export function chatOrigin(headers: Headers): string {
  const origin = requestOrigin(headers)
  if (!origin) return ''
  const url = new URL(origin)
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) url.port = String(CHAT_PORT)
  return url.origin
}

/**
 * 带一次性 token 的聊天台入口地址。
 * @param ctx - 插件上下文；可缺省（测试或非 web profile）。
 * @param headers - 入站请求头，用来推断对外 origin。
 * @returns 可直接 302 过去的绝对地址。
 */
export function chatEntryUrl(ctx: Context | undefined, headers: Headers): string {
  const origin = chatOrigin(headers)
  if (!origin) return '/'
  const connection = ctx === undefined
    ? undefined
    : (ctx as unknown as { get(name: string): unknown }).get('connection') as BrowserConnection | undefined
  if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return `${origin}/`
  return connection.authenticatedUrl(`${origin}/`)
}

/**
 * 生成"登录成功后跳哪"的判定函数。
 *
 * 仪表盘内部路径（`/lma/...`）只靠会话 Cookie 就能进，直接回原地址；
 * 其余（含根路径 `/`，即聊天台）一律走带 token 的入口 —— 否则聊天台的
 * `/api` 调用会因为缺少 dsh Cookie 而全部 401。
 * @param ctx - 插件上下文，用于取带 token 的入口地址。
 * @param headers - 入站请求头。
 * @returns 接受 `next`（可为 null）并返回落点地址的函数。
 */
export function loginTarget(ctx: Context | undefined, headers: Headers): (next: string | null) => string {
  return (next) => next !== null && /^\/lma(?:\/|$)/.test(next) ? next : chatEntryUrl(ctx, headers)
}

/**
 * 首页登录页地址（反代未登录时把人送去的地方）。
 *
 * 注意这里的 `next` 取的是**原始请求路径**：`forward_auth` 会把子请求的 URI 改写成
 * `/api/auth/verify`，同时把原 URI 放进 `X-Forwarded-Uri`，所以只能从那个头取。
 * @param headers - 入站请求头（反代会带 X-Forwarded-Host/Proto/Uri）。
 * @returns 绝对地址；取不到 origin 时退化为相对路径 `/login`。
 */
export function loginRedirectUrl(headers: Headers): string {
  const next = sanitizeNext(first(headers['x-forwarded-uri']))
  const origin = requestOrigin(headers)
  const path = next === null ? '/login' : `/login?next=${encodeURIComponent(next)}`
  return origin ? `${origin}${path}` : path
}

/** 判断是浏览器页面导航（Accept 带 text/html）还是接口调用：决定未登录时给 302 还是 401。 */
export function wantsHtml(headers: Headers): boolean {
  return String(first(headers.accept) ?? '').includes('text/html')
}

/** 从 `next` 查询参数里取候选落点：只接受站内绝对路径，挡掉 `//evil.com` 这类开放跳转。 */
export function sanitizeNext(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim()
  return value.startsWith('/') && !value.startsWith('//') ? value : null
}

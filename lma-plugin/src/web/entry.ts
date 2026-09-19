// 站点入口：登录成功后落地仪表盘（独立版无 dsh 聊天台交接）
//
// 独立版（main.ts）下，仪表盘就是主站：登录成功 → 直接落地 `/`。
// 本文件保留 origin 推断、next 防开放跳转、页面/接口分流等纯 HTTP 逻辑。

/** 聊天 UI（dsh web）监听端口。本机开发时它与 LMA 端口（默认 3081）不同，故需显式知道。 */
export const CHAT_PORT = Number(process.env.LMA_CHAT_PORT ?? 3080)

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
 * 登录成功后的落地地址（独立版：仪表盘即主站）。
 * @param headers - 入站请求头，用来推断对外 origin。
 * @returns 可直接 302 过去的绝对地址。
 */
export function chatEntryUrl(_headers: Headers): string {
  const origin = requestOrigin(_headers)
  return origin ? `${origin}/` : '/'
}

/**
 * 生成"登录成功后跳哪"的判定函数：有 next（站内路径）用 next，否则落地 `/`。
 * @returns 接受 `next`（可为 null）并返回落点地址的函数。
 */
export function loginTarget(_headers: Headers): (next: string | null) => string {
  return (next) => sanitizeNext(next) ?? '/'
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

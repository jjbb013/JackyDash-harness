/**
 * 「LMA 推广」面板里 iframe 指向的仪表盘地址。
 *
 * 两种部署形态的地址不一样，所以不能写死：
 *   - 本机开发：LMA Web 服务在另一个端口（`LMA_HTTP_PORT`，默认 3081），聊天台在 3080；
 *   - 公网部署：仪表盘挂在**同一个域名**的 `/lma/` 子路径下（反代剥掉前缀后转给 3081）。
 *
 * 之前写死 `http://127.0.0.1:3081/`，公网访客的浏览器会去连**自己的本机** 3081 端口，
 * 面板一片空白 —— 本机永远看不出这个 bug。
 */
export interface LocationLike {
  /** `window.location.hostname`（IPv6 会带方括号）。 */
  hostname: string
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * 解析仪表盘入口地址。
 * @param location - 当前页面的位置（只用到 hostname）。
 * @returns 本机回环地址用另一个端口；其余情况用同源 `/lma/` 子路径。
 */
export function dashboardHomeUrl(location: LocationLike): string {
  const host = location.hostname.replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTNAMES.has(host) ? 'http://127.0.0.1:3081/' : '/lma/'
}

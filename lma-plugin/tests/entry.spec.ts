// 站点入口交接（F-AUTH-05）单元测试：origin 推断、端口换算、开放跳转防护
//
// 这些都是"部署形态相关"的纯函数，出错时表现是"登录后跳到一个点不开的地址"，
// 所以单独钉住。端口用 vitest.config.ts 里钉死的 LMA_CHAT_PORT=3080。
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  CHAT_PORT, requestOrigin, chatOrigin, chatEntryUrl, loginTarget, sanitizeNext,
} from '../src/web/entry.ts'

/** 造一个只暴露指定服务的假 Context（真 Context 在这里没有别的用途） */
const fakeCtx = (services: Record<string, unknown>): Context =>
  ({ get: (name: string) => services[name] }) as unknown as Context

const CONNECTION = { authenticatedUrl: (base: string) => `${base}?token=FAKE-TOKEN` }

describe('requestOrigin', () => {
  it('优先用反代传来的 X-Forwarded-Proto/Host', () => {
    expect(requestOrigin({ host: '127.0.0.1:3081', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'lma.example.com' }))
      .toBe('https://lma.example.com')
  })

  it('直连时退回 Host 与 http', () => {
    expect(requestOrigin({ host: '127.0.0.1:3081' })).toBe('http://127.0.0.1:3081')
  })

  it('没有 Host 时返回空串（调用方据此退化为相对地址）', () => {
    expect(requestOrigin({})).toBe('')
  })
})

describe('chatOrigin', () => {
  it('公网反代：与 LMA 同源，不加端口', () => {
    expect(chatOrigin({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'jackydash.will-pan.com' }))
      .toBe('https://jackydash.will-pan.com')
  })

  it('本机：同一台机器的另一个端口（默认 3080）', () => {
    expect(chatOrigin({ host: '127.0.0.1:3081' })).toBe(`http://127.0.0.1:${String(CHAT_PORT)}`)
    expect(chatOrigin({ host: 'localhost:9999' })).toBe(`http://localhost:${String(CHAT_PORT)}`)
  })
})

describe('chatEntryUrl', () => {
  it('有 connection 服务时取带一次性 token 的入口', () => {
    expect(chatEntryUrl(fakeCtx({ connection: CONNECTION }), { host: '127.0.0.1:3081' }))
      .toBe('http://127.0.0.1:3080/?token=FAKE-TOKEN')
  })

  it('没有 connection 服务时退化为不带 token 的根地址，不给死链', () => {
    expect(chatEntryUrl(undefined, { host: '127.0.0.1:3081' })).toBe('http://127.0.0.1:3080/')
    expect(chatEntryUrl(fakeCtx({}), { host: '127.0.0.1:3081' })).toBe('http://127.0.0.1:3080/')
  })

  it('拿不到 Host 时退回相对根路径', () => {
    expect(chatEntryUrl(undefined, {})).toBe('/')
  })
})

describe('loginTarget', () => {
  const target = loginTarget(fakeCtx({ connection: CONNECTION }), { host: '127.0.0.1:3081' })

  it('仪表盘内部路径原样返回（会话 Cookie 就够）', () => {
    expect(target('/lma/review')).toBe('/lma/review')
    expect(target('/lma/')).toBe('/lma/')
  })

  it('其余一律走聊天台入口（要一并取到 dsh Cookie）', () => {
    expect(target('/')).toBe('http://127.0.0.1:3080/?token=FAKE-TOKEN')
    expect(target(null)).toBe('http://127.0.0.1:3080/?token=FAKE-TOKEN')
    expect(target('/lmafoo')).toBe('http://127.0.0.1:3080/?token=FAKE-TOKEN')
  })
})

describe('sanitizeNext', () => {
  it('只接受站内绝对路径', () => {
    expect(sanitizeNext('/lma/review')).toBe('/lma/review')
    expect(sanitizeNext('/')).toBe('/')
    expect(sanitizeNext('  /lma/x  ')).toBe('/lma/x')
  })

  it('挡掉开放跳转与相对路径', () => {
    for (const bad of ['//evil.example.com', 'https://evil.example.com', 'javascript:alert(1)', 'lma/x', '', null, undefined]) {
      expect(sanitizeNext(bad)).toBeNull()
    }
  })
})

// 站点入口（独立版）单元测试：origin 推断、开放跳转防护、登录落点
//
// 独立版无 dsh 聊天台交接：登录成功直接落地仪表盘 `/`。
// 端口换算（LMA_CHAT_PORT=3080）保留，仅供 chatOrigin 推断对外地址用。
import { describe, expect, it } from 'vitest'
import {
  CHAT_PORT, requestOrigin, chatOrigin, chatEntryUrl, loginTarget, sanitizeNext,
} from '../src/web/entry.ts'

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

describe('chatEntryUrl（独立版：仪表盘即主站）', () => {
  it('有 Host 时返回 origin 根地址（独立版仪表盘即主站，不换端口）', () => {
    expect(chatEntryUrl({ host: '127.0.0.1:3081' })).toBe('http://127.0.0.1:3081/')
    expect(chatEntryUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'lma.example.com' }))
      .toBe('https://lma.example.com/')
  })

  it('拿不到 Host 时退回相对根路径', () => {
    expect(chatEntryUrl({})).toBe('/')
  })
})

describe('loginTarget（独立版：落地仪表盘，next 须通过开放跳转校验）', () => {
  const target = loginTarget({ host: '127.0.0.1:3081' })

  it('站内绝对路径原样落地', () => {
    expect(target('/lma/review')).toBe('/lma/review')
    expect(target('/')).toBe('/')
  })

  it('无 next 或非法 next 一律回 `/`', () => {
    expect(target(null)).toBe('/')
    expect(target('//evil.example.com')).toBe('/')
    expect(target('https://evil.example.com')).toBe('/')
    expect(target('lma/x')).toBe('/')
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

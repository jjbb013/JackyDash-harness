// 侧边栏「LMA 推广」面板 iframe 地址的推断规则（本机 vs 公网）
//
// 写死 http://127.0.0.1:3081/ 的版本在本机一切正常，公网访客却会让浏览器去连
// 自己的 3081 端口 —— 面板空白，而且本地怎么测都测不出来。所以这条规则单独钉住。
import { describe, expect, it } from 'vitest'
import { dashboardHomeUrl } from '../src/client/dashboard-url.ts'

describe('dashboardHomeUrl', () => {
  it('本机回环地址：聊天台在 3080、仪表盘在另一个端口', () => {
    expect(dashboardHomeUrl({ hostname: '127.0.0.1' })).toBe('http://127.0.0.1:3081/')
    expect(dashboardHomeUrl({ hostname: 'localhost' })).toBe('http://127.0.0.1:3081/')
    expect(dashboardHomeUrl({ hostname: '[::1]' })).toBe('http://127.0.0.1:3081/')
  })

  it('公网域名：同一个 origin 下的 /lma/ 子路径（反代剥前缀）', () => {
    expect(dashboardHomeUrl({ hostname: 'jackydash.will-pan.com' })).toBe('/lma/')
    expect(dashboardHomeUrl({ hostname: 'lma.example.com' })).toBe('/lma/')
  })

  it('内网 IP 也走子路径（不是回环就不是本机开发）', () => {
    expect(dashboardHomeUrl({ hostname: '192.168.1.10' })).toBe('/lma/')
  })
})

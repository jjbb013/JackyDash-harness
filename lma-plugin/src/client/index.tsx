// LMA 客户端插件（dsh web 顶部入口）：在侧边栏全局面板列表注册「LMA 推广」图标，
// 点击后主区展示插件自带的 Web 仪表盘（iframe 嵌入 127.0.0.1:LMA_HTTP_PORT）。
// 仅依赖 react（PLATFORM_MODULES 基线），零跨包类型依赖，避免 tsc 项目引用地狱。
import { createElement, type CSSProperties } from 'react'

export const name = 'lma-client'
export const inject = ['slots']

// 插件 Web 服务默认端口（LMA_HTTP_PORT，见 lma-plugin/src/index.ts）。bundle 内禁止读 process.env。
const LMA_HOME = 'http://127.0.0.1:3081/'

const frameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
  display: 'block',
  background: '#fff',
}

function LmaPanel() {
  return createElement('iframe', {
    src: LMA_HOME,
    title: 'LMA 物流推广智能体系统',
    style: frameStyle,
  })
}

function LmaIcon({ size = 18, active = false }: { size?: number; active?: boolean }) {
  const color = active ? 'var(--color-primary, #2563eb)' : 'currentColor'
  // 简笔卡车 + 信号弧：物流推广之意
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    createElement('path', { d: 'M1 8h12v9H1z' }),
    createElement('path', { d: 'M13 11h4l3 3v3h-7z' }),
    createElement('circle', { cx: 5.5, cy: 18.5, r: 1.8 }),
    createElement('circle', { cx: 16.5, cy: 18.5, r: 1.8 }),
    createElement('path', { d: 'M18.5 3.5a5 5 0 0 1 2 4' }),
    createElement('path', { d: 'M21 1.5a8 8 0 0 1 3.2 6.4', opacity: 0.5 }),
  )
}

// 最小 slots 契约（与 packages/client/ui-slots 的注册签名一致；不引包内类型）
interface SlotsRegistry {
  register(options: { name: string;[key: string]: unknown }, component: unknown): () => void
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
}
interface ClientContext {
  slots: SlotsRegistry
}

export function apply(ctx: ClientContext): void {
  // 槽位由 shell（ui-layout / ui-sidebar）在启动时声明，第三方插件必须用
  // slots.inject 延迟注册：等声明出现后再注册，避免启动顺序竞争。
  // 主区面板：key 与 sidebar.panellist 的 id 对应，选中后渲染 LmaPanel
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'lma' }, LmaPanel))
  // 侧边栏顶部全局面板列表入口（即"网页顶部入口"）
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: 'lma', order: 15, label: 'LMA 推广' }, LmaIcon))
}

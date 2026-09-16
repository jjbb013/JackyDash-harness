// 插件 client bundle 打包（手写最小配置，等价复刻 packages/client/tsdown.client.ts
// 的 clientConfig  essentials）：入口 lib/types/client/index.js → lib/client.js（固定名），
// CJS + ModuleLoader 握手 banner。react 走模块表 external（PLATFORM_MODULES 基线）。
// 不用 clientBundle 预设的唯一原因：其 workspaceManifest 门禁按 packages/*/*/package.json
// 发现包，而本插件按 AGENTS.md 约定位于仓库根 lma-plugin/。
// 仅在本目录手动执行：pnpm --filter @lma/dsh-plugin run build:client
import { defineConfig } from 'tsdown'
import { clientBuildEnvironmentDefines } from '../scripts/client-build-environment.ts'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../packages/client/web/src/platform.ts'

const id = '@lma/dsh-plugin'
const externals = new Set<string>([...PLATFORM_MODULES, ...PRELOADED_CLIENT_EXTERNALS])

export default defineConfig({
  name: `${id}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => externals.has(specifier),
    alwaysBundle: (specifier: string) => !externals.has(specifier),
  },
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

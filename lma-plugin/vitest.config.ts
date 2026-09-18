import path from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

// LMA 插件本地测试配置：
// - 复用仓库 tsconfig.base.json 的路径映射（@deepseek-ai/cordis、dsh-tools 等走源码）
// - standardDecoratorPlugin：仓库源码使用 TS 装饰器，需要根 vitest 的预处理
// - env 在测试模块加载前注入（工具模块在 import 时读取环境变量）
// - 默认 mock 模式（不发真邮件、不连 IMAP）
// 运行：cd JackyDash-harness && pnpm vitest run --config lma-plugin/vitest.config.ts
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    tsconfigPaths({ projects: [path.join(import.meta.dirname, '..', 'tsconfig.base.json')] }),
    standardDecoratorPlugin(),
  ],
  test: {
    env: {
      LMA_ADMINS: 'test-admin',
      LMA_STAFF: 'test-staff',
      LMA_OPERATOR: 'test-admin',
      LMA_AI_MODE: 'mock',
      LMA_AI_URL: '',
      LMA_SMTP_HOST: '',
      LMA_SMTP_USER: '',
      LMA_MAIL_FROM: '',
      LMA_IMAP_ENABLED: 'false',
      LMA_COOKIE_SECRET: 'lma-test-secret',
      LMA_BASE_URL: 'http://127.0.0.1:3080',
    },
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

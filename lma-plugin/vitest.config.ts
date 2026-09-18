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
      // ⚠️ 与本插件相关的环境变量**全部显式钉死**。
      // 原因：这些变量都是"模块加载时读一次"，而测试进程会继承宿主 shell 的环境 ——
      // 真实踩过两次：宿主的 LMA_MAIL_FROM 让页脚断言随机失败；宿主的 LMA_ADMIN_USER=will
      // 让"空库引导管理员"用例造出了 will 而不是 admin。
      // 最危险的是 LMA_DB_PATH：一旦泄漏，测试可能直接写到真实数据库。
      LMA_DB_PATH: '',
      LMA_DB_BACKUP_DIR: '',
      LMA_HTTP_PORT: '3081',
      LMA_CHAT_PORT: '3080',
      LMA_PUBLIC_URL: '',
      LMA_COOKIE_SECURE: '',
      LMA_ADMIN_USER: 'admin',
      LMA_ADMIN_PASSWORD: '',
      LMA_AGENT_USER: 'test-agent',
      LMA_AGENT_ROLE: 'admin',
      LMA_SCRYPT_N: '16384',
      LMA_OPERATOR: 'test-admin',
      LMA_COOKIE_SECRET: 'lma-test-secret',
      LMA_BASE_URL: 'http://127.0.0.1:3080',
      LMA_SMTP_HOST: '', LMA_SMTP_PORT: '', LMA_SMTP_SECURE: '', LMA_SMTP_USER: '', LMA_SMTP_PASS: '',
      LMA_MAIL_FROM: '',
      LMA_IMAP_ENABLED: 'false', LMA_IMAP_HOST: '', LMA_IMAP_PORT: '', LMA_IMAP_TLS: '', LMA_IMAP_USER: '', LMA_IMAP_PASS: '',
      LMA_AI_MODE: 'mock', LMA_AI_URL: '', LMA_AI_KEY: '', LMA_AI_MODEL: 'deepseek-chat',
      LMA_ADMINS: '', LMA_STAFF: '',   // 已废弃，钉死以防残留
    },
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

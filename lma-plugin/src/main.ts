// LMA 物流推广智能体系统 —— 独立版启动入口（不依赖 DeepSeek Harness / Cordis）
//
// 与 dsh 插件版（index.ts）共用同一套业务代码：db / CSV 管道 / AI 匹配 / 邮件 /
// 发送队列 / IMAP / 跟进 / 审计 / auth / Web 仪表盘。差异只在最外层：
//   - 插件版：apply(ctx) 由 cordis 调用，工具注册到 ctx.tools
//   - 独立版：本文件直接执行，定时器原生 setInterval，Web 服务自启，
//     工具经 /api/assistant 由内置 AI 助手（LLM function calling）驱动
//
// 启动：node --experimental-strip-types --no-warnings src/main.ts
// 环境变量：见 README.md（LMA_DB_PATH / LMA_HTTP_PORT / LMA_ADMIN_* / LMA_SMTP_* / LMA_AI_* 等）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, setConfig, getConfig, TRANSTAR_PROFILE, DEFAULT_EMAIL_TEMPLATE, DEFAULT_SEND_POLICY } from './db.ts'
import { initQueueState, processDue } from './sendqueue.ts'
import { startImapPolling } from './imap.ts'
import { checkFollowups } from './followup.ts'
import { startWebServer } from './web/server.ts'
import { ensureBootstrapAdmin, ensureAgentAccount } from './auth/bootstrap.ts'
import { agentIdentitySummary } from './roles.ts'
import { purgeExpiredSessions } from './auth/session.ts'
import { purgeOldAttempts } from './auth/throttle.ts'
import { envSummary } from './env.ts'

const DB_PATH = process.env.LMA_DB_PATH
  ?? path.join(process.cwd(), 'lma-data', 'lma.db')
const BACKUP_DIR = process.env.LMA_DB_BACKUP_DIR ?? ''
const HTTP_PORT = Number(process.env.LMA_HTTP_PORT ?? 3081)

function seedDefaults(db: ReturnType<typeof openDb>): void {
  if (!getConfig(db, 'profile', null)) setConfig(db, 'profile', TRANSTAR_PROFILE, 'seed')
  if (!getConfig(db, 'email_template', null)) setConfig(db, 'email_template', DEFAULT_EMAIL_TEMPLATE, 'seed')
  if (!getConfig(db, 'send_policy', null)) setConfig(db, 'send_policy', DEFAULT_SEND_POLICY, 'seed')
}

function backupDb(db: ReturnType<typeof openDb>): void {
  if (!BACKUP_DIR || !fs.existsSync(DB_PATH)) return
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const stamp = new Date().toISOString().slice(0, 10)
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `lma-${stamp}.db`))
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^lma-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 14))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f))
    }
    console.log(`[lma] SQLite 备份完成：${BACKUP_DIR}/lma-${stamp}.db`)
  } catch (e) {
    console.error('[lma] SQLite 备份失败：', (e as Error).message)
  }
}

export function startLma(opts: { port?: number; dbPath?: string } = {}): void {
  const port = opts.port ?? HTTP_PORT
  const dbPath = opts.dbPath ?? DB_PATH

  const db = openDb(dbPath)
  seedDefaults(db)
  initQueueState(db)
  console.log(`[lma] SQLite 就绪：${dbPath}（WAL）`)

  const boot = ensureBootstrapAdmin(db)
  if (boot.created) {
    console.log(`[lma] 已创建首个管理员账号：${boot.username}`)
    if (boot.generatedPassword) {
      console.log(`[lma] ⚠️ 一次性初始密码（仅本次显示，首次登录后强制修改）：${boot.generatedPassword}`)
      console.log('[lma] 如需指定密码，请在启动前设置 LMA_ADMIN_USER / LMA_ADMIN_PASSWORD')
    }
  }
  const agent = ensureAgentAccount(db)
  if (agent.created) console.log(`[lma] 已登记 Agent 服务账号：${agent.username}（角色 ${agent.role}）`)
  console.log(`[lma] ${agentIdentitySummary(db)}`)
  console.log(`[lma] 运行环境：${envSummary(port)}`)

  // 定时任务（独立版原生 setInterval；保持引用以维持事件循环存活）
  const timers: NodeJS.Timeout[] = []

  const sendTick = setInterval(() => {
    processDue(db).catch((e) => console.error('[lma] send-queue tick error', (e as Error).message))
  }, 15_000)

  timers.push(sendTick)

  try { startImapPolling(db) } catch (e) { console.error('[lma] IMAP 启动失败：', (e as Error).message) }

  const followTick = setInterval(() => {
    checkFollowups(db, 'schedule').catch((e) => console.error('[lma] followup tick error', (e as Error).message))
  }, 6 * 3600_000)

  timers.push(followTick)

  const purgeTick = setInterval(() => {
    try { purgeExpiredSessions(db); purgeOldAttempts(db) } catch (e) { console.error('[lma] 清理失败：', (e as Error).message) }
  }, 3600_000)

  timers.push(purgeTick)

  if (BACKUP_DIR) {
    const backupTick = setInterval(() => backupDb(db), 24 * 3600_000)

    timers.push(backupTick)
  }

  // Web 仪表盘 + 登录 + JSON API + 退订端点（独立版即主站，不再交接聊天台）
  const webServer = startWebServer(db, port)

  console.log(`[lma] Web 服务已启动：http://127.0.0.1:${port}/（登录后进仪表盘；/unsubscribe 匿名可达）`)
  console.log('[lma] 独立版 LMA 已就绪。AI 助手见仪表盘聊天框；业务工具经 /api/assistant 由 LLM function calling 驱动。')

  const shutdown = () => {
    console.log('[lma] 正在关闭…')
    timers.forEach((t) => clearInterval(t))
    webServer.close()
    try { db.close() } catch { /* 已关闭 */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// 直接执行时启动（被 import 时不自动跑，便于测试）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startLma()
}

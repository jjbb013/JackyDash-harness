// LMA 物流推广智能体系统 —— DeepSeek Harness 插件入口
// 形态：Cordis 插件（name + apply + inject: ['tools']），加载后：
//   1. 打开 SQLite（node:sqlite，WAL），执行迁移，写入默认配置
//   2. 注册 23 个 lma_* 工具（模型可调用，完成导入/匹配/生成/审核/发送/追踪/配置/知识）
//   3. 注册应用内定时任务：发送队列 tick、IMAP 轮询（可选）、跟进检查（可选）、SQLite 备份（可选）
// 加载：pnpm dsh web --patch ./lma-plugin/cordis.yml
// 环境变量：见 README.md；LMA_DB_PATH 默认 <仓库根>/lma-data/lma.db
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { openDb, setConfig, getConfig, TRANSTAR_PROFILE, DEFAULT_EMAIL_TEMPLATE, DEFAULT_SEND_POLICY } from './db.ts'
import { buildLmaTools } from './tools.ts'
import { initQueueState, processDue } from './sendqueue.ts'
import { startImapPolling } from './imap.ts'
import { checkFollowups } from './followup.ts'
import { startWebServer } from './web/server.ts'
import { CHAT_PORT } from './web/entry.ts'
import { ensureBootstrapAdmin, ensureAgentAccount } from './auth/bootstrap.ts'
import { agentIdentitySummary } from './roles.ts'
import { purgeExpiredSessions } from './auth/session.ts'
import { purgeOldAttempts } from './auth/throttle.ts'
import { envSummary } from './env.ts'

export const name = 'lma'
export const inject = ['tools']

const DB_PATH = process.env.LMA_DB_PATH ?? path.join(process.cwd(), 'lma-data', 'lma.db')
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
    // 先把 WAL 落盘，再复制 db 文件，避免备份缺最近提交
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const stamp = new Date().toISOString().slice(0, 10)
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `lma-${stamp}.db`))
    // 保留最近 14 份
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^lma-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 14))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f))
    }
    console.log(`[lma] SQLite 备份完成：${BACKUP_DIR}/lma-${stamp}.db`)
  } catch (e) {
    console.error('[lma] SQLite 备份失败：', (e as Error).message)
  }
}

export function apply(ctx: Context): void {
  const db = openDb(DB_PATH)
  seedDefaults(db)
  initQueueState(db)
  console.log(`[lma] SQLite 就绪：${DB_PATH}（WAL）`)

  // 首个管理员引导：库里没有任何用户时创建，避免"加了登录墙却没人能登进去"
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
  console.log(`[lma] 运行环境：${envSummary(HTTP_PORT, CHAT_PORT)}`)

  // 注册全部业务工具
  const lmaTools = buildLmaTools(db)
  for (const tool of lmaTools) {
    ctx.tools.register(tool)
  }
  console.log(`[lma] 已注册 ${lmaTools.length} 个 lma_* 工具`)

  // 定时任务（ctx.effect 自动清理；均 unref，不阻塞进程退出）
  ctx.effect(() => {
    const timers: NodeJS.Timeout[] = []

    // 发送队列：每 15 秒处理到期项
    const sendTick = setInterval(() => {
      processDue(db).catch((e) => console.error('[lma] send-queue tick error', (e as Error).message))
    }, 15_000)
    sendTick.unref?.()
    timers.push(sendTick)

    // IMAP 轮询：由 imap.ts 自管首轮与 5 分钟间隔（F-TRACK-01）
    try { startImapPolling(db) } catch (e) { console.error('[lma] IMAP 启动失败：', (e as Error).message) }

    // 跟进检查：每 6 小时扫描一次（默认只生成草稿）
    const followTick = setInterval(() => {
      checkFollowups(db, 'schedule').catch((e) => console.error('[lma] followup tick error', (e as Error).message))
    }, 6 * 3600_000)
    followTick.unref?.()
    timers.push(followTick)

    // 会话与登录尝试清理：每小时一次，避免表无限增长
    const purgeTick = setInterval(() => {
      try { purgeExpiredSessions(db); purgeOldAttempts(db) } catch (e) { console.error('[lma] 清理失败：', (e as Error).message) }
    }, 3600_000)
    purgeTick.unref?.()
    timers.push(purgeTick)

    // 数据库每日备份（可选）
    if (BACKUP_DIR) {
      const backupTick = setInterval(() => backupDb(db), 24 * 3600_000)
      backupTick.unref?.()
      timers.push(backupTick)
    }

    // LMA Web 仪表盘 + 站点首页登录页 + 邮件退订端点 + 反代鉴权探针
    // 传 ctx 是为了在登录成功那一刻现取聊天台的带 token 入口（见 web/entry.ts）
    const webServer = startWebServer(db, HTTP_PORT, { ctx })
    webServer.unref?.()
    console.log(`[lma] Web 服务已启动：http://127.0.0.1:${HTTP_PORT}/（首页登录；/api/auth/verify 供反向代理鉴权；/unsubscribe 匿名可达）`)

    return () => {
      timers.forEach((t) => clearInterval(t))
      webServer.close()
      try { db.close() } catch { /* 已关闭 */ }
    }
  })

  console.log('[lma] LMA 物流推广智能体系统插件已加载。工具前缀 lma_*；知识库 lma_project_knowledge')
}

#!/usr/bin/env node
// 运维工具：设置 / 重置账号密码（纯 node + node:sqlite + crypto，**不需要 tsx**）
//
// 为什么需要它：密码哈希的存储格式是 scrypt$N$r$p$salt$hash（见 src/auth/passwords.ts），
// 直接用 sqlite3 写明文或自己拼格式容易写错；而"首个管理员引导"只在账号表为空时执行，
// 已有实例没法靠它改密码。
//
// 用法：
//   node lma-plugin/scripts/set-admin-password.mjs --username will --password 333333
//   node lma-plugin/scripts/set-admin-password.mjs --db /home/dsh/lma-data/lma.db \
//        --username will --role admin --password 333333
//   node lma-plugin/scripts/set-admin-password.mjs --list
//
// 选项：
//   --db <path>            数据库路径（默认 LMA_DB_PATH，否则 <仓库根>/lma-data/lma.db）
//   --username <name>      账号名（默认 will）
//   --password <pw>        新密码；**省略则生成 16 位随机密码并打印一次**
//   --role <admin|staff>   账号不存在时用它新建（默认 admin）
//   --force-change         要求下次登录必须改密（默认不要求 = 设完立即可用）
//   --list                 只列出账号，不做任何修改
//
// 安全提示：密码会出现在命令历史里。生产上更稳的做法是省略 --password 让它随机生成，
// 或先在 shell 里 `read -s` 再传入。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const opt = (k, dflt) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] !== undefined ? String(argv[i + 1]) : dflt
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const dbPath = opt('--db', process.env.LMA_DB_PATH || path.join(repoRoot, 'lma-data', 'lma.db'))
const username = opt('--username', 'will')
const role = opt('--role', 'admin')
const forceChange = flag('--force-change')
let password = opt('--password', '')

if (!fs.existsSync(dbPath)) {
  console.error(`✗ 数据库不存在：${dbPath}\n  先用 dsh web --patch lma-plugin/cordis.yml 启动一次，插件会自动建库`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)

if (flag('--list')) {
  const rows = db.prepare('SELECT id, username, role, status, must_change_password, last_login_at FROM lma_user ORDER BY id').all()
  console.log(`账号列表（${dbPath}）：`)
  for (const r of rows) {
    console.log(`  #${r.id} ${r.username}\t${r.role}\t${r.status}\t${r.must_change_password ? '待改密' : '—'}\t最近登录 ${r.last_login_at ?? '从未'}`)
  }
  db.close()
  process.exit(0)
}

// 与 src/auth/passwords.ts 完全一致的哈希格式与参数
const N = Number(process.env.LMA_SCRYPT_N || 65536)
const R = 8, P = 1, KEYLEN = 32
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16)
  const h = crypto.scryptSync(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`
}
const generate = (len = 16) => {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const b = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += a[b[i] % a.length]
  return out
}

const generated = !password
if (generated) password = generate(16)
if (password.length < 6) {
  console.error('✗ 密码至少 6 位')
  process.exit(1)
}

const existing = db.prepare('SELECT id, role, status FROM lma_user WHERE username = ?').get(username)
if (existing) {
  db.prepare(`UPDATE lma_user SET password_hash = ?, must_change_password = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hashPassword(password), forceChange ? 1 : 0, existing.id)
  // 改密后销毁该账号全部会话（与界面改密行为一致）
  const killed = db.prepare('DELETE FROM lma_session WHERE user_id = ?').run(existing.id)
  console.log(`✅ 已重置账号 ${username} 的密码（角色 ${existing.role}，状态 ${existing.status}）`)
  console.log(`   已失效会话数：${Number(killed.changes ?? 0)}`)
} else {
  if (!['admin', 'staff'].includes(role)) {
    console.error('✗ --role 只能是 admin 或 staff')
    process.exit(1)
  }
  const r = db.prepare(
    `INSERT INTO lma_user (username, password_hash, role, status, must_change_password)
     VALUES (?, ?, ?, 'active', ?)`,
  ).run(username, hashPassword(password), role, forceChange ? 1 : 0)
  console.log(`✅ 已创建账号 ${username}（id ${Number(r.lastInsertRowid)}，角色 ${role}）`)
  db.prepare('INSERT INTO audit_log (username, action, object, object_id, detail, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))')
    .run('cli', 'user.set_password_cli', 'lma_user', Number(r.lastInsertRowid), JSON.stringify({ role, generated }))
}

if (generated) console.log(`\n一次性密码（仅本次显示）：${password}`)
else console.log('\n（密码来自 --password，未回显）')
console.log(`登录后如需强制改密，加 --force-change 重跑；强制改密的账号首登会被要求设置 ≥10 位新密码。`)
db.close()

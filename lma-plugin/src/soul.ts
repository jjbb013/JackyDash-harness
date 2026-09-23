// Soul 长期记忆：把驳回原因与 AI 聊天中的邮件需求沉淀为本地 soul 文件，
// 生成邮件草稿时自动注入 prompt，让 AI 不是一次性生成而是持续遵循团队偏好。
import fs from 'node:fs'
import path from 'node:path'
import type { Db } from './db.ts'

export interface SoulEntry {
  type: 'reject' | 'chat' | 'manual'
  at: string
  text: string
}

const SOUL_HEADER = `# LMA Soul — 邮件生成长期记忆

> 本文件由系统自动沉淀（草稿驳回原因 / AI 聊天中的邮件需求），并在每次生成邮件草稿时注入 AI 参考。
> 你可以直接编辑或清空本文件；请保持每一条为一句明确的持久规则（如「不要在开头提 WCA 网络」）。

## 记忆

`

/** soul 文件路径：env LMA_SOUL_PATH 优先，否则与数据库同目录（soul.md） */
export function soulPath(db: Db): string {
  if (process.env.LMA_SOUL_PATH) return process.env.LMA_SOUL_PATH
  return path.join(path.dirname(dbPathOf(db)), 'soul.md')
}

function dbPathOf(db: Db): string {
  // 通过 db 内部属性取数据库路径；拿不到时退回默认目录
  const raw = (db as unknown as { name?: string }).name
  return raw && raw !== ':memory:' ? raw : path.join(process.cwd(), 'lma-data', 'lma.db')
}

/** 读取 soul 全文（不存在返回头部模板） */
export function readSoul(db: Db): string {
  const p = soulPath(db)
  try {
    const t = fs.readFileSync(p, 'utf-8')
    return t.includes('# LMA Soul') ? t : SOUL_HEADER + t
  } catch {
    return SOUL_HEADER
  }
}

/** 追加一条记忆（自动带时间戳与来源；文件不存在时先写头部） */
export function appendSoul(db: Db, entry: SoulEntry): void {
  const p = soulPath(db)
  const stamp = new Date().toISOString().slice(0, 10)
  const tag = entry.type === 'reject' ? '草稿驳回' : entry.type === 'chat' ? 'AI 聊天需求' : '手工'
  const line = `- [${stamp}]（${tag}）${entry.text.replace(/\s+/g, ' ').trim()}`
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
    fs.writeFileSync(p, cur.endsWith('\n') ? cur + line + '\n' : (cur || SOUL_HEADER) + line + '\n')
  } catch (e) {
    console.error('[lma] soul 写入失败：', (e as Error).message)
  }
}

/** 整体替换 soul 内容（页面编辑/清空） */
export function writeSoul(db: Db, text: string): void {
  const p = soulPath(db)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const t = text.trim()
  fs.writeFileSync(p, t ? (t.includes('# LMA Soul') ? t : SOUL_HEADER + t) : SOUL_HEADER)
}

/** 解析 soul 中的记忆条目（供页面展示） */
export function parseSoul(text: string): SoulEntry[] {
  const entries: SoulEntry[] = []
  for (const m of text.matchAll(/^- \[(\d{4}-\d{2}-\d{2})\]（([^）]+)）(.+)$/gm)) {
    const type = m[2] === '草稿驳回' ? 'reject' : m[2] === 'AI 聊天需求' ? 'chat' : 'manual'
    entries.push({ type, at: m[1], text: m[3].trim() })
  }
  return entries
}

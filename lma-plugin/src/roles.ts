// 角色与权限 —— 全系统权限判定的**唯一收敛点**
//
//   admin（管理员）：全部 —— 导入/导出数据、配置、管理账号、维护业务画像、审核、发送、看统计
//   staff（业务伙伴）：业务操作 —— 查看列表、审核邮件、发送、标记跟进、导出数据
//
// 账号来源唯一：**`lma_user` 表**（无自助注册，由 admin 在「人员管理」中创建）。
// 两条调用链都从这里取角色：
//   1. Web 层：Cookie → 会话 → 用户（server.ts 调 readSession，角色随会话返回）
//   2. 工具层：**服务身份**（F-AUTH-07）——Agent 工具由插件以固定服务账号执行，
//      **绝不接受模型传入的操作者**，否则模型只要填一个管理员名字就能自封 admin。
//
// 前端隐藏按钮只是体验，后端必须强制（本文件就是那道闸）。

import type { Db } from './db.ts'

export type Role = 'admin' | 'staff'

const ROLES: readonly string[] = ['admin', 'staff']

/** 查账号当前角色；不存在或已禁用返回 null */
export function roleOfUser(db: Db, username: string): Role | null {
  const name = String(username ?? '').trim()
  if (!name) return null
  const row = db.prepare("SELECT role FROM lma_user WHERE username = ? AND status = 'active'").get(name) as { role: string } | undefined
  return row && ROLES.includes(row.role) ? (row.role as Role) : null
}

export interface Permission {
  ok: boolean
  operator: string
  role?: Role
  error?: string
}

/** 校验某身份是否具备 allowed 中的任一角色 */
export function requireRoleOf(db: Db, operator: string, allowed: Role[]): Permission {
  const role = roleOfUser(db, operator)
  if (!role || !allowed.includes(role)) {
    const need = allowed.includes('admin') && allowed.includes('staff')
      ? '管理员或业务伙伴'
      : allowed.includes('admin') ? '管理员' : '业务伙伴'
    return {
      ok: false, operator,
      error: `当前身份（${operator}）无${need}权限；账号与角色由管理员在「人员管理」中维护`,
    }
  }
  return { ok: true, operator, role }
}

/**
 * Agent 工具的服务身份（F-AUTH-07）。
 * 由 LMA_AGENT_USER 指定（默认 harness-agent），角色取自 `lma_user`。
 * 这是"聊天 UI 里谁能做什么"的唯一决定因素 —— 模型无法通过工具参数改变它。
 */
export function agentIdentity(): string {
  return ((process.env.LMA_AGENT_USER ?? 'harness-agent').trim()) || 'harness-agent'
}

/** 启动日志用：当前服务身份与其角色 */
export function agentIdentitySummary(db: Db): string {
  const who = agentIdentity()
  const role = roleOfUser(db, who)
  return role
    ? `服务身份=${who}（${role === 'admin' ? '管理员' : '业务伙伴'}）`
    : `服务身份=${who}（⚠️ 未在 lma_user 中登记或已禁用 —— 受控工具将全部拒绝）`
}

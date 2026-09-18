// 角色与权限（PRD「三、用户角色」）——全系统权限判定的**唯一收敛点**
//
//   admin（管理员）：全部 —— 导入/导出数据、配置、管理账号、维护业务画像、审核、发送、看统计
//   staff（业务伙伴）：业务操作 —— 查看列表、审核邮件、发送、标记跟进、导出数据
//
// 约束（PRD）：登录仅对指定人员开放、无自助注册、账号由管理员创建；
// CSV 导入仅 admin，导出 admin 与 staff 均可；两种角色共用一个页面，前端按角色控制按钮可见性。
//
// 当前实现：名单来自环境变量 LMA_ADMINS / LMA_STAFF，在模块加载时读取。
// 接入登录后改为查 DB 的 lma_user 表（已含 username/password_hash/role/status）——
// **只需改本文件**，调用方（tools.ts / web/api.ts）无需改动。
//
// 注意：前端隐藏按钮只是体验，后端必须强制校验（本文件就是后端那道闸）。

export type Role = 'admin' | 'staff'

const roleSet = (v: string | undefined): Set<string> =>
  new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean))

const ADMINS = roleSet(process.env.LMA_ADMINS)
const STAFF = roleSet(process.env.LMA_STAFF)

/** 未显式传 operator 时的默认审计操作者 */
export const DEFAULT_OPERATOR = process.env.LMA_OPERATOR ?? 'harness-agent'

/** 解析操作者角色；不在任何名单里返回 null（= 未授权） */
export function roleOf(operator: string): Role | null {
  if (ADMINS.has(operator)) return 'admin'
  if (STAFF.has(operator)) return 'staff'
  return null
}

export interface Permission {
  ok: boolean
  operator: string
  role?: Role
  error?: string
}

/** 校验操作者是否具备 allowed 中的任一角色 */
export function requireRole(operator: string, allowed: Role[]): Permission {
  const role = roleOf(operator)
  if (!role || !allowed.includes(role)) {
    const need = allowed.includes('admin') && allowed.includes('staff')
      ? '管理员或业务伙伴'
      : allowed.includes('admin') ? '管理员' : '业务伙伴'
    return {
      ok: false, operator,
      error: `当前操作者（${operator}）无${need}权限；名单由 LMA_ADMINS / LMA_STAFF 环境变量指定`,
    }
  }
  return { ok: true, operator, role }
}

export const isAdmin = (operator: string): boolean => roleOf(operator) === 'admin'
export const isAuthorized = (operator: string): boolean => roleOf(operator) !== null

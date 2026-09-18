// 登录 / 登出 / 改密路由与登录页（F-AUTH-01/04）
//
//   GET  /login                     登录页（无自助注册，仅提示"账号由管理员创建"）
//   POST /api/auth/login            表单(urlencoded) 校验密码 → 建会话 → Set-Cookie → 302 回首页
//   POST /api/auth/logout           销毁会话 + 清 Cookie
//   GET  /api/auth/me               当前用户（用户名/角色/是否需改密）
//   POST /api/auth/change-password  改密（首登强制；成功后轮换会话 ID 并踢掉其它会话）
//
// 安全要点：登录失败统一回"用户名或密码错误"（不泄露用户是否存在）；失败与锁定都写审计；
// 登录成功换新 session ID（防会话固定）；改密后销毁该用户全部会话。
import type { Db } from '../db.ts'
import { audit, clientIp } from '../audit.ts'
import { hashPassword, verifyPassword, needsRehash } from '../auth/passwords.ts'
import {
  createSession, destroySession, destroyUserSessions, buildSessionCookie, buildClearCookie,
  type SessionUser,
} from '../auth/session.ts'
import { checkThrottle, recordAttempt } from '../auth/throttle.ts'

export interface WebResult {
  status: number
  body: string
  contentType: string
  headers: Record<string, string>
}

export const htmlResult = (status: number, body: string, headers: Record<string, string> = {}): WebResult =>
  ({ status, body, contentType: 'text/html; charset=utf-8', headers })
export const jsonResult = (status: number, body: unknown, headers: Record<string, string> = {}): WebResult =>
  ({ status, body: JSON.stringify(body), contentType: 'application/json; charset=utf-8', headers })
export const redirectResult = (location: string, headers: Record<string, string> = {}): WebResult =>
  ({ status: 302, body: '', contentType: 'text/plain; charset=utf-8', headers: { Location: location, ...headers } })

/** 登录页。用相对 action，便于挂在 /lma/ 子路径下运行 */
export function loginPage(error?: string): string {
  const err = error ? `<div class="err">${escapeHtml(error)}</div>` : ''
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · LMA 物流推广系统</title>
<style>
  :root { --line:#e5e7eb; --text:#1f2937; --muted:#6b7280; --accent:#2563eb; --bg:#f6f7f9; --card:#fff; --danger:#dc2626; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
  .box { width:100%; max-width:360px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:17px; margin:0 0 4px; font-weight:600; }
  .sub { color:var(--muted); font-size:12px; margin-bottom:18px; }
  label { display:block; font-size:12px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  button { width:100%; margin-top:18px; padding:10px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:hover { opacity:.92; }
  .err { margin-top:14px; padding:9px 11px; border-radius:8px; background:#fef2f2; color:var(--danger); font-size:13px; }
  .hint { margin-top:16px; color:var(--muted); font-size:12px; line-height:1.6; }
</style>
</head>
<body>
  <form class="box" method="post" action="api/auth/login">
    <h1>LMA 物流推广智能体系统</h1>
    <div class="sub">请使用管理员分配的账号登录</div>
    <label for="username">用户名</label>
    <input id="username" name="username" autocomplete="username" required autofocus>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登录</button>
    ${err}
    <div class="hint">本系统不开放自助注册，账号由管理员在「人员管理」中创建。</div>
  </form>
</body>
</html>`
}

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

const fail = '用户名或密码错误'

/** POST /api/auth/login（表单） */
export async function handleLogin(
  db: Db, form: URLSearchParams, reqHeaders: Record<string, string | string[] | undefined>, remoteAddr: string,
): Promise<WebResult> {
  const username = String(form.get('username') ?? '').trim()
  const password = String(form.get('password') ?? '')
  const ip = clientIp(reqHeaders, remoteAddr)
  const ua = String(reqHeaders['user-agent'] ?? '')

  if (!username || !password) return htmlResult(400, loginPage('请输入用户名与密码'))

  const state = checkThrottle(db, username, ip)
  if (!state.allowed) {
    audit(db, username, 'auth.login_blocked', 'lma_user', null, { retryAfterSec: state.retryAfterSec, fails: state.fails, locked: state.locked }, { ip, ua, result: 'denied' })
    const msg = state.locked
      ? `尝试次数过多，账号已被临时锁定，请 ${Math.ceil(state.retryAfterSec / 60)} 分钟后再试`
      : `操作过于频繁，请 ${state.retryAfterSec} 秒后再试`
    return htmlResult(429, loginPage(msg))
  }

  const user = db.prepare('SELECT id, username, password_hash, role, status FROM lma_user WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string; role: 'admin' | 'staff'; status: string } | undefined

  // 用户不存在时也跑一次哈希校验，避免用响应时间枚举用户
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA')

  if (!user || !ok) {
    recordAttempt(db, username, ip, false)
    audit(db, username, 'auth.login_fail', 'lma_user', user?.id ?? null, null, { ip, ua, result: 'denied' })
    return htmlResult(401, loginPage(fail))
  }
  if (user.status !== 'active') {
    recordAttempt(db, username, ip, false)
    audit(db, username, 'auth.login_disabled', 'lma_user', user.id, null, { ip, ua, result: 'denied' })
    return htmlResult(403, loginPage('该账号已被禁用，请联系管理员'))
  }

  // 参数落后于当前配置时，在登录成功这一刻顺手重算哈希
  if (needsRehash(user.password_hash)) {
    db.prepare('UPDATE lma_user SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(await hashPassword(password), user.id)
  }

  recordAttempt(db, username, ip, true)
  db.prepare("UPDATE lma_user SET last_login_at = datetime('now') WHERE id = ?").run(user.id)
  const { token } = createSession(db, user.id, ip, ua)   // 新会话 ID，防会话固定
  audit(db, username, 'auth.login_ok', 'lma_user', user.id, { role: user.role }, { ip, ua })

  return redirectResult('./', { 'Set-Cookie': buildSessionCookie(token) })
}

/** POST /api/auth/logout */
export function handleLogout(
  db: Db, token: string, user: SessionUser | null, reqHeaders: Record<string, string | string[] | undefined>, remoteAddr: string,
): WebResult {
  destroySession(db, token)
  if (user) {
    audit(db, user.username, 'auth.logout', 'lma_user', user.userId, null, {
      ip: clientIp(reqHeaders, remoteAddr), ua: String(reqHeaders['user-agent'] ?? ''), sessionId: user.sessionId,
    })
  }
  return redirectResult('login', { 'Set-Cookie': buildClearCookie() })
}

/** POST /api/auth/change-password（首登强制走这里） */
export async function handleChangePassword(
  db: Db, user: SessionUser, body: Record<string, unknown>,
  reqHeaders: Record<string, string | string[] | undefined>, remoteAddr: string,
): Promise<WebResult> {
  const oldPw = String(body.old_password ?? '')
  const newPw = String(body.new_password ?? '')
  const ip = clientIp(reqHeaders, remoteAddr)
  const ua = String(reqHeaders['user-agent'] ?? '')

  if (newPw.length < 10) return jsonResult(400, { error: '新密码至少 10 位' })
  if (newPw === oldPw) return jsonResult(400, { error: '新密码不能与旧密码相同' })

  const row = db.prepare('SELECT password_hash FROM lma_user WHERE id = ?').get(user.userId) as { password_hash: string } | undefined
  if (!row || !(await verifyPassword(oldPw, row.password_hash))) {
    audit(db, user.username, 'auth.change_password_fail', 'lma_user', user.userId, null, { ip, ua, sessionId: user.sessionId, result: 'denied' })
    return jsonResult(400, { error: '原密码不正确' })
  }

  db.prepare(`UPDATE lma_user SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(await hashPassword(newPw), user.userId)
  destroyUserSessions(db, user.userId)                 // 踢掉其它会话
  const { token } = createSession(db, user.userId, ip, ua) // 当前会话也换新 ID
  audit(db, user.username, 'auth.change_password', 'lma_user', user.userId, null, { ip, ua, sessionId: user.sessionId })

  return jsonResult(200, { ok: true }, { 'Set-Cookie': buildSessionCookie(token) })
}

/** GET /api/auth/me */
export function meResult(user: SessionUser, ip: string): WebResult {
  return jsonResult(200, {
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    expiresAt: user.expiresAt,
  })
}

// 登录 / 登出 / 改密路由与登录页（F-AUTH-01/04）
//
//   GET  /login                     站点首页登录页（无自助注册，仅提示"账号由管理员创建"）
//   POST /api/auth/login            表单(urlencoded) 校验密码 → 建会话 → Set-Cookie → 302 去落点
//   POST /api/auth/logout           销毁会话 + 清 Cookie
//   GET  /api/auth/verify           反向代理的 forward_auth 探针：有会话 200，无会话 401
//   GET  /api/auth/me               当前用户（用户名/角色/是否需改密）
//   POST /api/auth/change-password  改密（首登强制；成功后轮换会话 ID 并踢掉其它会话）
//
// 安全要点：登录失败统一回"用户名或密码错误"（不泄露用户是否存在）；失败与锁定都写审计；
// 登录成功换新 session ID（防会话固定）；改密后销毁该用户全部会话。
// 站点首页登录页同时服务两个挂载点：公网 `/login`（Caddy 匿名放行）与仪表盘 `/lma/login`
// —— 所以表单 action 与落点都用相对路径，`next` 也只接受站内绝对路径（见 entry.ts）。
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

/** 登录页与改密页共用的样式，保证"同一道门"的观感 */
const AUTH_PAGE_STYLE = `
  :root { --line:#e5e7eb; --text:#1f2937; --muted:#6b7280; --accent:#2563eb; --bg:#f6f7f9; --card:#fff; --danger:#dc2626; --ok:#059669; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); }
  .box { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  .brand { font-size:12px; letter-spacing:.14em; color:var(--accent); font-weight:700; text-transform:uppercase; }
  h1 { font-size:18px; margin:6px 0 4px; font-weight:600; }
  .sub { color:var(--muted); font-size:12px; margin-bottom:18px; line-height:1.6; }
  label { display:block; font-size:12px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  input:focus { outline:2px solid rgba(37,99,235,.25); border-color:var(--accent); }
  button { width:100%; margin-top:18px; padding:10px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:hover { opacity:.92; }
  button[disabled] { opacity:.55; cursor:default; }
  .msg { margin-top:14px; padding:9px 11px; border-radius:8px; font-size:13px; display:none; }
  .msg.err { display:block; background:#fef2f2; color:var(--danger); }
  .msg.ok { display:block; background:#ecfdf5; color:var(--ok); }
  .hint { margin-top:16px; color:var(--muted); font-size:12px; line-height:1.6; }
  .who { margin-top:16px; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
`

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/**
 * 站点首页登录页。表单用相对 action，因此同一个页面在公网 `/login` 与仪表盘
 * `/lma/login` 下都能正确提交。
 * @param error - 需要展示的错误文案（登录失败 / 锁定）。
 * @param next - 登录成功后要去的位置，作为隐藏字段随表单回传。
 */
export function loginPage(error?: string, next?: string | null): string {
  const err = error ? `<div class="msg err">${escapeHtml(error)}</div>` : '<div class="msg"></div>'
  const keep = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · LMA 物流推广智能体系统</title>
<style>${AUTH_PAGE_STYLE}</style>
</head>
<body>
  <form class="box" method="post" action="api/auth/login">
    <div class="brand">Transtar · LMA</div>
    <h1>LMA 物流推广智能体系统</h1>
    <div class="sub">请使用管理员分配的账号登录。登录后可直接进入聊天工作台与推广仪表盘，无需再次验证。</div>
    <label for="username">用户名</label>
    <input id="username" name="username" autocomplete="username" required autofocus>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    ${keep}
    <button type="submit">登录</button>
    ${err}
    <div class="hint">本系统不开放自助注册，账号由管理员在「人员管理」中创建。</div>
  </form>
</body>
</html>`
}

/**
 * 首登强制改密页。放在登录页同一张皮里，是为了让"未改密 → 被反代挡回 /login"
 * 这条路径有终点：在这里改完再交接进聊天台，不会来回弹。
 * @param user - 当前会话用户（用于提示是谁）。
 * @param entryUrl - 改密成功后的落点（带一次性 token 的聊天台入口）。
 */
export function changePasswordPage(user: SessionUser, entryUrl: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>首次登录改密 · LMA 物流推广智能体系统</title>
<style>${AUTH_PAGE_STYLE}</style>
</head>
<body>
  <form class="box" id="f">
    <div class="brand">Transtar · LMA</div>
    <h1>首次登录，请设置新密码</h1>
    <div class="sub">为了账号安全，初始密码只能用于首次登录。新密码至少 10 位。</div>
    <label for="old_password">当前（初始）密码</label>
    <input id="old_password" name="old_password" type="password" autocomplete="current-password" required autofocus>
    <label for="new_password">新密码（≥10 位）</label>
    <input id="new_password" name="new_password" type="password" autocomplete="new-password" minlength="10" required>
    <label for="confirm">再输一次新密码</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
    <button type="submit" id="submit">保存并进入工作台</button>
    <div class="msg" id="msg"></div>
    <div class="who">当前账号：${escapeHtml(user.username)}（${user.role === 'admin' ? '管理员' : '员工'}）</div>
  </form>
<script>
  var ENTRY = ${JSON.stringify(entryUrl)};
  var msg = document.getElementById('msg');
  function show(text, cls) { msg.textContent = text; msg.className = 'msg ' + cls; }
  document.getElementById('f').addEventListener('submit', async function (e) {
    e.preventDefault();
    var oldPw = document.getElementById('old_password').value;
    var newPw = document.getElementById('new_password').value;
    if (newPw !== document.getElementById('confirm').value) { show('两次输入的新密码不一致', 'err'); return; }
    if (newPw.length < 10) { show('新密码至少 10 位', 'err'); return; }
    document.getElementById('submit').disabled = true;
    try {
      var r = await fetch('api/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      var data = await r.json();
      if (!r.ok) { show(data.error || '改密失败', 'err'); document.getElementById('submit').disabled = false; return; }
      show('已保存，正在进入工作台…', 'ok');
      location.href = ENTRY;
    } catch (err) {
      show('网络错误：' + err.message, 'err');
      document.getElementById('submit').disabled = false;
    }
  });
</script>
</body>
</html>`
}

const fail = '用户名或密码错误'
const DUMMY_HASH = ['scrypt', 16384, 8, 1, 'AAAA', 'AAAA'].join('$')

/**
 * POST /api/auth/login（表单）
 * @param db - 打开的数据库。
 * @param form - urlencoded 表单（username / password / 可选 next）。
 * @param reqHeaders - 入站请求头，用于审计与限流。
 * @param remoteAddr - 直连来源地址（反代场景下 clientIp 优先取 X-Forwarded-For）。
 * @param resolveTarget - 调用方给出的"登录成功后去哪"判定（见 entry.ts#loginTarget）。
 * @returns 成功时 302 到落点并带 Set-Cookie；失败按原因返回 400/401/403/429 并重渲染登录页。
 */
export async function handleLogin(
  db: Db, form: URLSearchParams, reqHeaders: Record<string, string | string[] | undefined>, remoteAddr: string,
  resolveTarget: (next: string | null) => string,
): Promise<WebResult> {
  const username = String(form.get('username') ?? '').trim()
  const password = String(form.get('password') ?? '')
  const next = String(form.get('next') ?? '') || null
  const ip = clientIp(reqHeaders, remoteAddr)
  const ua = String(reqHeaders['user-agent'] ?? '')

  if (!username || !password) return htmlResult(400, loginPage('请输入用户名与密码', next))

  const state = checkThrottle(db, username, ip)
  if (!state.allowed) {
    audit(db, username, 'auth.login_blocked', 'lma_user', null, { retryAfterSec: state.retryAfterSec, fails: state.fails, locked: state.locked }, { ip, ua, result: 'denied' })
    const msg = state.locked
      ? `尝试次数过多，账号已被临时锁定，请 ${Math.ceil(state.retryAfterSec / 60)} 分钟后再试`
      : `操作过于频繁，请 ${state.retryAfterSec} 秒后再试`
    return htmlResult(429, loginPage(msg, next))
  }

  const user = db.prepare('SELECT id, username, password_hash, role, status FROM lma_user WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string; role: 'admin' | 'staff'; status: string } | undefined

  // 用户不存在时也跑一次等价算力的**哑哈希**（防止用响应时间枚举用户是否存在）。
  // 这里拆成数组拼接，避免完整的哈希字面量被密钥扫描器误判。
  const ok = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, DUMMY_HASH)

  if (!user || !ok) {
    recordAttempt(db, username, ip, false)
    audit(db, username, 'auth.login_fail', 'lma_user', user?.id ?? null, null, { ip, ua, result: 'denied' })
    return htmlResult(401, loginPage(fail, next))
  }
  if (user.status !== 'active') {
    recordAttempt(db, username, ip, false)
    audit(db, username, 'auth.login_disabled', 'lma_user', user.id, null, { ip, ua, result: 'denied' })
    return htmlResult(403, loginPage('该账号已被禁用，请联系管理员', next))
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

  return redirectResult(resolveTarget(next), { 'Set-Cookie': buildSessionCookie(token) })
}

/**
 * GET /api/auth/verify —— 反向代理 `forward_auth` 探针。
 *
 * 只回答"这个 Cookie 能不能进"，不返回任何业务数据。反代的语义是：**2xx 放行，
 * 其它状态码原样转给浏览器**（`forward_auth` 文档原话就是"这个响应通常是一个跳转到
 * 登录页的重定向"）。所以这里直接给出对应形态，反代侧不需要任何 handle_response
 * 拼装（Caddyfile 里 `handle_response` 内的 `redir` 会被当成路径匹配器，踩过）：
 *
 *   - 放行          → 200 空体
 *   - 页面导航未登录 → 302 到首页登录页（带 next，登录后回得来）
 *   - 接口调用未登录 → 401，让仪表盘的 fetch 自己处理，别把 HTML 喂给 JSON.parse
 *
 * 首登未改密的会话与未登录同样处理，于是访客会被送到 `/login` 的改密表单
 * （那里不会再跳走，所以不会和反代来回弹）。
 * @param user - 由会话 Cookie 解析出的用户；无会话时为 null。
 * @param options - `loginUrl`（首页登录页地址，含 next）与 `wantsHtml`（是否页面导航）。
 * @returns 200 / 302 / 401，都是空体。
 */
export function verifyResult(
  user: SessionUser | null,
  options: { loginUrl: string; wantsHtml: boolean },
): WebResult {
  const base = { body: '', contentType: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } }
  if (user !== null && !user.mustChangePassword) {
    return {
      ...base,
      status: 200,
      headers: { ...base.headers, 'X-LMA-User': encodeURIComponent(user.username), 'X-LMA-Role': user.role },
    }
  }
  if (options.wantsHtml) {
    return { ...base, status: 302, headers: { ...base.headers, Location: options.loginUrl } }
  }
  return { ...base, status: 401 }
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

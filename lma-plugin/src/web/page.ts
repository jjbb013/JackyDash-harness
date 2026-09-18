// LMA 仪表盘页面：单文件 HTML（内联 CSS/JS），由插件 Web 服务在 / 提供（需登录）
// 身份与角色由服务端注入到 window 上的 LMA_USER，前端据此过滤 tab/按钮；
// 所有请求走**相对路径**，因此本页可挂在子路径（如反向代理的 /lma/）下运行。
// ⚠️ 前端隐藏只是体验，真正的权限判定在 web/api.ts 的 ROUTE_ROLES（后端强制）。
export interface PageUser { username: string; role: 'admin' | 'staff'; mustChangePassword: boolean }

/** HTML 属性值转义（入口地址里带一次性 token，必须按属性上下文转义）。 */
function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/**
 * 渲染仪表盘页面。
 * @param user - 当前会话用户（注入前端用于过滤 tab 与按钮；真正的权限判定在后端）。
 * @param chatHref - 「进入聊天工作台」的地址（带一次性 token，见 web/entry.ts）。
 * @returns 完整的仪表盘 HTML。
 */
export function dashboardPage(user: PageUser, chatHref = '/'): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LMA 物流推广系统</title>
<style>
  :root { --line:#e5e7eb; --text:#1f2937; --muted:#6b7280; --accent:#2563eb; --bg:#f6f7f9; --card:#fff; --danger:#dc2626; --ok:#16a34a; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); font-size:14px; }
  header { display:flex; align-items:center; gap:12px; padding:12px 20px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:10; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .op { margin-left:auto; display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }
  header .op a.chat { padding:5px 12px; border:1px solid var(--line); border-radius:6px; color:var(--accent); text-decoration:none; }
  header .op a.chat:hover { border-color:var(--accent); background:#eff6ff; }
  input, select, button, textarea { font:inherit; }
  input[type=text], input[type=number] { padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:#fff; }
  button { padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:#fff; cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  button.primary:hover { opacity:.9; color:#fff; }
  button.danger { color:var(--danger); }
  nav { display:flex; gap:4px; padding:8px 20px 0; }
  nav button { border:none; background:none; padding:8px 14px; border-radius:8px 8px 0 0; color:var(--muted); }
  nav button.active { background:var(--card); color:var(--text); font-weight:600; }
  main { padding:16px 20px 40px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:14px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:12px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .stat .v { font-size:24px; font-weight:700; }
  .stat .k { color:var(--muted); font-size:12px; margin-top:2px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; white-space:nowrap; }
  tr:last-child td { border-bottom:none; }
  .tag { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; background:#eef2ff; color:#3730a3; }
  .tag.sent { background:#ecfdf5; color:#065f46; }
  .tag.replied { background:#eff6ff; color:#1d4ed8; }
  .tag.unsubscribed, .tag.invalid { background:#fef2f2; color:#b91c1c; }
  .tag.approved, .tag.matched { background:#fffbeb; color:#92400e; }
  .muted { color:var(--muted); }
  .row2 { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
  .expand { background:#fafafa; border-top:1px dashed var(--line); }
  pre { white-space:pre-wrap; margin:6px 0 0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  #toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#111827; color:#fff; padding:8px 16px; border-radius:8px; display:none; z-index:99; }
  .err { color:var(--danger); }
</style>
</head>
<body>
<header>
  <h1>LMA 物流推广智能体系统</h1>
  <div class="op"><a class="chat" id="chat" href="${escapeAttr(chatHref)}">聊天工作台 ↗</a><span id="whoami" class="muted"></span><button id="logout" type="button">退出</button></div>
</header>
<nav id="tabs"></nav>
<main id="view"></main>
<div id="toast"></div>
<script>
// 第三项是该 tab 所需角色（省略 = 两角色都可见）；后端仍会独立判定
const TABS = [
  ['overview', '总览'], ['review', '审核队列'], ['suppliers', '供应商'],
  ['queue', '发送队列'], ['unsub', '退订名单'], ['config', '配置', 'admin'], ['users', '人员管理', 'admin'],
]
const USER = ${JSON.stringify(user)}
const visibleTabs = () => TABS.filter((t) => !t[2] || t[2] === USER.role)
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const fmt = (s) => s ? String(s).replace('T', ' ').slice(0, 19) : '—'
let tab = 'overview'

$('#whoami').textContent = USER.username + '（' + (USER.role === 'admin' ? '管理员' : '业务伙伴') + '）'
$('#logout').onclick = async () => {
  try { await fetch('api/auth/logout', { method: 'POST' }) } catch (e) { /* 忽略 */ }
  location.href = 'login'
}
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.style.background = isErr ? '#b91c1c' : '#111827'; t.style.display = 'block'
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2600)
}
async function api(path, opts = {}) {
  // 相对路径：本页可挂在 /lma/ 子路径下（反代剥前缀，浏览器保留前缀）
  // 不要用正则 + 反斜杠：page.ts 是模板字符串，\/ 会被还原成 / 导致生成出坏 JS（曾整个仪表盘脚本语法错误）
  const url = String(path).charAt(0) === '/' ? String(path).slice(1) : String(path)
  const r = await fetch(url, { ...opts, headers: { ...(opts.body ? {'Content-Type':'application/json'} : {}), ...(opts.headers || {}) } })
  const j = await r.json().catch(() => ({}))
  if (r.status === 401) { location.href = 'login'; throw new Error('会话已过期，请重新登录') }
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
  return j
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })

function statusTag(s) { return '<span class="tag ' + esc(s) + '">' + esc(s) + '</span>' }

// ---------- 总览 ----------
async function renderOverview() {
  const d = await api('/api/overview')
  const countryRows = d.byCountry.map((r) => '<tr><td>' + esc(r.country) + '</td><td>' + r.c + '</td></tr>').join('')
  const statusRows = d.byStatus.map((r) => '<tr><td>' + statusTag(r.status) + '</td><td>' + r.c + '</td></tr>').join('')
  $('#view').innerHTML =
    '<div class="stats">' +
    stat(d.supplierTotal, '供应商总数') + stat(d.sent, '累计发送') + stat(d.replied, '累计回复') +
    stat(d.replyRate + '%', '回复率') + stat(d.todaySent, '今日已发') + stat(d.queuePending, '发送队列中') + stat(d.pendingReview, '待审核草稿') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px" class="ovgrid">' +
    '<div class="card"><b>国家分布</b><table style="margin-top:8px">' + countryRows + '</table></div>' +
    '<div class="card"><b>状态分布</b><table style="margin-top:8px">' + statusRows + '</table></div>' +
    '</div>'
}
function stat(v, k) { return '<div class="stat"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>' }

// ---------- 审核队列 ----------
async function renderReview() {
  const d = await api('/api/review-queue?status=draft&size=50')
  const rows = d.rows.map((r) =>
    '<tr><td>#' + r.id + '</td><td>' + esc(r.company_name) + '<br><span class="muted">' + esc(r.email) + ' · ' + esc(r.country || '') + '</span></td>' +
    '<td>' + esc(r.subject) + '<br><span class="muted">匹配度 ' + (r.match_score ?? '—') + ' · ' + fmt(r.created_at) + '</span>' +
    '<div style="margin-top:6px"><a href="javascript:void 0" onclick="toggleBody(' + r.id + ')">查看正文</a>' +
    '<div id="body-' + r.id + '" style="display:none" class="expand"><pre>' + esc(r.body) + '</pre></div></div></td>' +
    '<td style="white-space:nowrap"><button class="primary" onclick="doReview(' + r.id + ', \\'approve\\')">批准</button> ' +
    '<button class="danger" onclick="doReview(' + r.id + ', \\'reject\\')">驳回</button></td></tr>').join('')
  $('#view').innerHTML = '<div class="card"><b>待审核草稿（' + d.total + '）</b>' +
    (d.total ? '<table style="margin-top:8px"><tr><th>ID</th><th>供应商</th><th>草稿</th><th>操作</th></tr>' + rows + '</table>'
             : '<p class="muted">队列空空如也。让 Agent 用 lma_draft 生成草稿后会出现在这里。</p>') + '</div>'
}
window.toggleBody = (id) => { const el = $('#body-' + id); el.style.display = el.style.display === 'none' ? 'block' : 'none' }
window.doReview = async (id, action) => {
  let reason
  if (action === 'reject') { reason = prompt('驳回原因（必填）：'); if (!reason) return }
  try {
    await post('/api/review', { draft_id: id, action, reason })
    toast(action === 'approve' ? '已批准，可用 lma_send 发送' : '已驳回'); renderReview()
  } catch (e) { toast(e.message, true) }
}

// ---------- 供应商 ----------
let supQ = { page: 1 }
async function renderSuppliers() {
  const p = new URLSearchParams({ page: supQ.page, size: 20 })
  if (supQ.country) p.set('country', supQ.country)
  if (supQ.status) p.set('status', supQ.status)
  if (supQ.q) p.set('q', supQ.q)
  const d = await api('/api/suppliers?' + p)
  const pages = Math.max(1, Math.ceil(d.total / d.size))
  const rows = d.rows.map((r) =>
    '<tr><td>' + r.id + '</td><td>' + esc(r.company_name) + '<br><span class="muted">' + esc(r.contact_name || '') + '</span></td>' +
    '<td>' + esc(r.email) + '</td><td>' + esc(r.country || '—') + '</td><td>' + statusTag(r.status) + '</td>' +
    '<td>' + (r.match_score ?? '—') + '</td><td><a href="javascript:void 0" onclick="toggleDetail(' + r.id + ')">详情</a></td></tr>' +
    '<tr id="detail-' + r.id + '" style="display:none"><td colspan="7" class="expand"><div class="muted">加载中…</div></td></tr>').join('')
  $('#view').innerHTML = '<div class="card">' +
    '<div class="row2"><input type="text" id="f-q" placeholder="关键词" value="' + esc(supQ.q || '') + '">' +
    '<input type="text" id="f-country" placeholder="国家，如 NL" value="' + esc(supQ.country || '') + '" size="8">' +
    '<select id="f-status"><option value="">全部状态</option>' + ['new','matched','drafted','approved','sent','replied','follow_up','unsubscribed','invalid'].map((s) =>
      '<option ' + (supQ.status === s ? 'selected' : '') + '>' + s + '</option>').join('') + '</select>' +
    '<button class="primary" onclick="searchSup()">筛选</button>' +
    '<button data-act="export">导出 CSV（当前筛选）</button>' +
    '<span class="muted">共 ' + d.total + ' 条 · 第 ' + d.page + '/' + pages + ' 页</span>' +
    (d.page > 1 ? ' <button onclick="gotoPage(' + (d.page - 1) + ')">上一页</button>' : '') +
    (d.page < pages ? ' <button onclick="gotoPage(' + (d.page + 1) + ')">下一页</button>' : '') + '</div>' +
    '<table><tr><th>ID</th><th>公司</th><th>邮箱</th><th>国家</th><th>状态</th><th>匹配度</th><th></th></tr>' + rows + '</table></div>' +
    importCard()
}

// ---------- CSV 导入（仅 admin；与 Agent 工具共用同一套管道） ----------
function importCard() {
  if (USER.role !== 'admin') return ''
  return '<div class="card"><b>CSV 导入（仅管理员）</b>' +
    '<p class="muted">选择 CSV（UTF-8，≤5000 行 / 5MB，支持 WCA 导出模板）。先预览字段映射与校验统计，确认后再落库。</p>' +
    '<div class="row2"><input type="file" id="imp-file" accept=".csv,text/csv">' +
    '<button class="primary" data-act="imp-preview">预览</button></div>' +
    '<div id="imp-step2"></div><div id="imp-out"></div></div>'
}
window.searchSup = () => { supQ = { page: 1, q: $('#f-q').value.trim(), country: $('#f-country').value.trim(), status: $('#f-status').value }; renderSuppliers() }
window.gotoPage = (p) => { supQ.page = p; renderSuppliers() }
window.toggleDetail = async (id) => {
  const el = $('#detail-' + id)
  if (el.style.display !== 'none') { el.style.display = 'none'; return }
  el.style.display = 'table-row'
  const d = await api('/api/supplier?id=' + id)
  const evs = d.events.map((e) => '<tr><td>' + fmt(e.event_time) + '</td><td>' + statusTag(e.event_type) + '</td><td>' + esc(e.draft_subject || '') + '</td></tr>').join('')
  el.cells[0].innerHTML = '<b>主营：</b>' + esc(d.supplier.business || '—') + '<br><b>网络：</b>' + esc(d.supplier.networks || '—') +
    '<br><b>来源：</b>' + esc(d.supplier.source || '—') + '<br><b>介绍：</b>' + esc((d.supplier.profile || '').slice(0, 300)) +
    (evs ? '<br><b>事件时间线</b><table style="margin-top:4px">' + evs + '</table>' : '<br><span class="muted">暂无事件</span>')
}

// ---------- 发送队列 ----------
async function renderQueue() {
  const d = await api('api/send-queue')
  const approved = await api('api/review-queue?status=approved&size=50')
  const rows = d.pending.map((q) =>
    '<tr><td>草稿 #' + q.draftId + '</td><td>供应商 #' + q.supplierId + '</td><td>' + fmt(q.dueAtIso) + '</td><td>' + esc(q.reason || '—') + '</td></tr>').join('')
  const waiting = approved.rows.map((r) =>
    '<tr><td>#' + r.id + '</td><td>' + esc(r.company_name) + '</td><td>' + esc(r.subject) + '</td>' +
    '<td style="white-space:nowrap"><button class="primary" data-act="send" data-id="' + r.id + '">发送</button></td></tr>').join('')
  const p = d.policy
  $('#view').innerHTML = '<div class="stats">' + stat(d.todaySent + ' / ' + p.dailyLimit, '今日已发 / 上限') +
    stat(p.intervalMinutes + ' 分钟', '节流间隔') + stat(p.checkWorkingHours ? (p.workStart + ':00–' + p.workEnd + ':00') : '关闭', '对方工作时段') +
    stat(d.pending.length, '队列中') + stat(approved.total, '已批准待发送') + '</div>' +
    '<div class="card" style="margin-top:14px"><b>已批准待发送</b>' +
    (waiting ? '<table style="margin-top:8px"><tr><th>草稿</th><th>公司</th><th>主题</th><th></th></tr>' + waiting + '</table>'
             : '<p class="muted">没有已批准的草稿 —— 先到「审核队列」批准。</p>') + '</div>' +
    '<div class="card"><b>待发队列</b>' +
    (rows ? '<table style="margin-top:8px"><tr><th>草稿</th><th>供应商</th><th>预计发送</th><th>说明</th></tr>' + rows + '</table>'
          : '<p class="muted">队列为空。</p>') + '</div>' +
    '<div class="card"><b>跟进</b>' +
    '<p class="muted">按规则扫描 3 天未回复的已发送供应商并生成跟进草稿（默认只进审核队列，不直接发）。</p>' +
    '<div class="row2"><button class="primary" data-act="followup">执行跟进检查</button></div></div>'
}

// ---------- 退订名单 ----------
async function renderUnsub() {
  const d = await api('/api/unsubscribes')
  const rows = d.rows.map((r) =>
    '<tr><td>' + esc(r.email) + '</td><td>' + esc(r.source) + '</td><td>' + fmt(r.unsubscribed_at) + '</td><td>' + esc(r.note || '') + '</td></tr>').join('')
  $('#view').innerHTML = '<div class="card">' +
    '<div class="row2"><input type="text" id="u-email" placeholder="邮箱"><input type="text" id="u-note" placeholder="备注（可选）">' +
    '<button class="primary" onclick="addUnsub()">添加退订</button></div>' +
    '<table><tr><th>邮箱</th><th>来源</th><th>退订时间</th><th>备注</th></tr>' + rows + '</table></div>'
}
window.addUnsub = async () => {
  try {
    await post('/api/unsubscribe', { email: $('#u-email').value, note: $('#u-note').value })
    toast('已加入退订名单'); renderUnsub()
  } catch (e) { toast(e.message, true) }
}

// ---------- 配置 ----------
async function renderConfig() {
  const d = await api('/api/config')
  $('#view').innerHTML = '<div class="card"><b>业务画像（' + esc(d.profile.companyName) + '）</b><pre>' + esc(d.profile.intro) + '</pre>' +
    '<p><b>服务：</b>' + esc(d.profile.services.join('；')) + '</p><p><b>优势：</b>' + esc(d.profile.strengths.join('；')) +
    '</p><p><b>目标市场：</b>' + esc(d.profile.targetMarkets.join(', ')) + '</p></div>' +
    '<div class="card"><b>邮件模板约束</b><p class="muted">主题 ≤ ' + d.email_template.subjectMax + ' 字符 · 正文 ≤ ' + d.email_template.bodyMaxWords +
    ' 词 · 禁用词：' + esc(d.email_template.bannedWords.join(', ')) + '</p></div>' +
    '<div class="card"><b>发送策略</b><pre>' + esc(JSON.stringify(d.send_policy, null, 2)) + '</pre></div>' +
    '<div class="card"><b>AI 端点配置</b>' +
    '<p class="muted">支持 DeepSeek 与任意 OpenAI 兼容端点（代码会拼 /chat/completions）。mock 为离线规则，不调用任何外部接口。</p>' +
    '<div class="row2"><select id="ai-mode"><option value="mock">mock（离线规则）</option><option value="api">api（调用端点）</option></select>' +
    '<input type="text" id="ai-url" size="32" placeholder="https://api.deepseek.com/v1">' +
    '<input type="text" id="ai-model" size="15" placeholder="deepseek-chat"></div>' +
    '<div class="row2"><input type="password" id="ai-key" size="26" placeholder="API Key（留空保持不变）">' +
    '<button class="primary" data-act="save-ai">保存</button>' +
    '<button data-act="clear-ai-key">清除 Key</button></div>' +
    '<div class="muted" id="ai-state"></div></div>'

  const ai = await api('api/ai-config')
  $('#ai-mode').value = ai.mode
  $('#ai-url').value = ai.url
  $('#ai-model').value = ai.model
  $('#ai-state').textContent = ai.keySet ? ('当前 Key：' + ai.keyMasked) : '当前未设置 Key（api 模式必须设置）'
}

// ---------- 人员管理（仅 admin；无自助注册，账号只能在这里创建） ----------
async function renderUsers() {
  const d = await api('api/users')
  const rows = d.rows.map((u) => '<tr>'
    + '<td>' + esc(u.username) + '</td>'
    + '<td>' + (u.role === 'admin' ? '管理员' : '业务伙伴') + '</td>'
    + '<td>' + (u.status === 'active' ? '<span class="tag sent">启用</span>' : '<span class="tag invalid">已禁用</span>') + '</td>'
    + '<td>' + (u.must_change_password ? '<span class="tag approved">待改密</span>' : '—') + '</td>'
    + '<td class="muted">' + fmt(u.last_login_at) + '</td>'
    + '<td>' + u.sessions + '</td>'
    + '<td style="white-space:nowrap">'
      + (u.status === 'active'
        ? '<button data-act="status" data-id="' + u.id + '" data-status="disabled">禁用</button>'
        : '<button data-act="status" data-id="' + u.id + '" data-status="active">启用</button>')
      + ' <button data-act="role" data-id="' + u.id + '" data-role="' + (u.role === 'admin' ? 'staff' : 'admin') + '">'
      + (u.role === 'admin' ? '降为业务伙伴' : '升为管理员') + '</button>'
      + ' <button data-act="reset" data-id="' + u.id + '">重置密码</button>'
    + '</td></tr>').join('')

  $('#view').innerHTML =
    '<div class="card"><b>新建账号</b>'
    + '<p class="muted">系统不提供自助注册，账号只能在这里创建。初始密码为一次性，对方首次登录必须修改。</p>'
    + '<div class="row2"><input type="text" id="nu-name" placeholder="用户名（2~32 位字母/数字/._-）">'
    + '<select id="nu-role"><option value="staff">业务伙伴</option><option value="admin">管理员</option></select>'
    + '<button class="primary" data-act="create">创建</button></div>'
    + '<div id="nu-pw"></div></div>'
    + '<div class="card"><b>账号列表</b>'
    + '<table style="margin-top:8px"><tr><th>用户名</th><th>角色</th><th>状态</th><th>改密</th><th>最近登录</th><th>会话</th><th>操作</th></tr>'
    + rows + '</table></div>'
}

// 一次性密码只在此处显示一次，不写日志
function showTempPassword(username, pw) {
  const el = $('#nu-pw')
  if (el) el.innerHTML = '<div class="card" style="background:#fffbeb"><b>一次性初始密码（请立即转告本人；离开本页后无法再查看）</b>'
    + '<pre>' + esc(username) + '  ' + esc(pw) + '</pre></div>'
}

// 用事件委托，避免在 onclick 里拼字符串（也免去转义地狱）
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null
  if (!btn) return
  const act = btn.dataset.act
  const id = Number(btn.dataset.id)
  try {
    if (act === 'create') {
      const r = await post('api/users', { username: $('#nu-name').value, role: $('#nu-role').value })
      await renderUsers()
      showTempPassword(r.username, r.tempPassword)
      toast('账号已创建')
    } else if (act === 'status') {
      await post('api/users/update', { id, action: 'set_status', status: btn.dataset.status })
      await renderUsers(); toast('状态已更新')
    } else if (act === 'role') {
      await post('api/users/update', { id, action: 'set_role', role: btn.dataset.role })
      await renderUsers(); toast('角色已更新')
    } else if (act === 'reset') {
      const r = await post('api/users/update', { id, action: 'reset_password' })
      await renderUsers()
      showTempPassword(r.username, r.tempPassword)
      toast('已重置密码，该账号的旧会话已全部失效')
    } else if (act === 'send') {
      const r = await post('api/send', { draft_id: id })
      toast(r.queued ? '已入队，预计 ' + fmt(r.dueAt) + ' 发送' : '已排队等待条件满足' + (r.reason ? '（' + r.reason + '）' : ''))
      await renderQueue()
    } else if (act === 'followup') {
      const r = await post('api/followup', {})
      toast('扫描 ' + r.scanned + ' 家，生成 ' + r.created + ' 封跟进草稿')
      await renderQueue()
    } else if (act === 'imp-preview') {
      const f = $('#imp-file').files && $('#imp-file').files[0]
      if (!f) { toast('请先选择 CSV 文件', true); return }
      const text = await f.text()
      const r = await post('api/import/preview', { content: text })
      window.__impBatch = r.batch_id
      $('#imp-step2').innerHTML = '<div class="row2">' +
        '<select id="imp-strategy"><option value="skip">skip（跳过已有）</option><option value="update">update（更新已有）</option><option value="create">create（新建）</option></select>' +
        '<input type="text" id="imp-source" size="32" placeholder="数据来源备注（合规必填）">' +
        '<button class="primary" data-act="imp-confirm">确认导入</button></div>'
      $('#imp-out').innerHTML = '<pre>' + esc(JSON.stringify({ stats: r.stats, mapping: r.mapping, unmapped: r.unmapped }, null, 2)) + '</pre>'
      toast('预览完成：合法 ' + r.stats.valid + ' / 异常 ' + r.stats.invalid + ' / 重复 ' + r.stats.duplicate)
    } else if (act === 'imp-confirm') {
      const r = await post('api/import/confirm', {
        batch_id: window.__impBatch, dedupe_strategy: $('#imp-strategy').value, source_note: $('#imp-source').value,
      })
      $('#imp-out').innerHTML = '<pre>' + esc(JSON.stringify(r.report, null, 2)) + '</pre>'
      toast('导入完成：成功 ' + r.report.successRows + ' / 失败 ' + r.report.failedRows)
    } else if (act === 'save-ai') {
      const r = await post('api/ai-config', {
        mode: $('#ai-mode').value, url: $('#ai-url').value, model: $('#ai-model').value, key: $('#ai-key').value,
      })
      toast('AI 配置已保存（' + r.mode + '）')
      await renderConfig()
    } else if (act === 'clear-ai-key') {
      // 清 Key 必然离开 api 模式，所以一并切回 mock（否则会被"api 必须有 Key"的校验拒绝）
      await post('api/ai-config', { mode: 'mock', key: '__clear__' })
      toast('已清除 API Key 并切回 mock 模式')
      await renderConfig()
    } else if (act === 'export') {
      const qs = new URLSearchParams()
      if (supQ.country) qs.set('country', supQ.country)
      if (supQ.status) qs.set('status', supQ.status)
      if (supQ.q) qs.set('q', supQ.q)
      location.href = 'api/export' + (qs.toString() ? '?' + qs.toString() : '')
    }
  } catch (err) { toast(err.message, true) }
})

// ---------- 框架 ----------
const RENDER = { overview: renderOverview, review: renderReview, suppliers: renderSuppliers, queue: renderQueue, unsub: renderUnsub, config: renderConfig, users: renderUsers }
function renderTabs() {
  $('#tabs').innerHTML = visibleTabs().map(([id, label]) =>
    '<button class="' + (tab === id ? 'active' : '') + '" onclick="switchTab(\\'' + id + '\\')">' + label + '</button>').join('')
}
window.switchTab = (t) => { tab = t; renderTabs(); RENDER[t]().catch((e) => { $('#view').innerHTML = '<div class="card err">加载失败：' + esc(e.message) + '</div>' }) }
// 首登强制改密：未改密前不渲染业务页面（后端也会用 428 拦住写操作）
function mustChangePasswordView() {
  $('#tabs').innerHTML = ''
  $('#view').innerHTML = '<div class="card"><b>首次登录，请先修改密码</b>'
    + '<p class="muted">管理员分配的是一次性临时密码，修改后才能使用系统。</p>'
    + '<div class="row2"><input type="password" id="pw-old" placeholder="当前（临时）密码">'
    + '<input type="password" id="pw-new" placeholder="新密码（至少 10 位）">'
    + '<button class="primary" id="pw-go">提交</button></div>'
    + '<div id="pw-msg" class="muted"></div></div>'
  $('#pw-go').onclick = async () => {
    try {
      await post('api/auth/change-password', { old_password: $('#pw-old').value, new_password: $('#pw-new').value })
      toast('密码已修改，正在进入系统…')
      setTimeout(() => location.reload(), 800)
    } catch (e) { $('#pw-msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>' }
  }
}

if (USER.mustChangePassword) {
  mustChangePasswordView()
} else {
  renderTabs()
  window.switchTab('overview')
}
setInterval(() => { if (tab === 'overview' || tab === 'queue') RENDER[tab]().catch(() => {}) }, 15000)
</script>
</body>
</html>`
}

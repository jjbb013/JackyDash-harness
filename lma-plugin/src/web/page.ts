// LMA 仪表盘页面：单文件 HTML（内联 CSS/JS），由插件 Web 服务在 / 提供
// 数据全部来自同源的 /api/*；写操作带 X-LMA-Operator 头（管理员校验）
export function dashboardPage(): string {
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
  <div class="op">操作者 <input type="text" id="operator" size="10" placeholder="名字"> <span class="muted" id="opHint"></span></div>
</header>
<nav id="tabs"></nav>
<main id="view"></main>
<div id="toast"></div>
<script>
const TABS = [
  ['overview', '总览'], ['review', '审核队列'], ['suppliers', '供应商'], ['queue', '发送队列'], ['unsub', '退订名单'], ['config', '配置'],
]
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const fmt = (s) => s ? String(s).replace('T', ' ').slice(0, 19) : '—'
let tab = 'overview'

const op = $('#operator')
op.value = localStorage.getItem('lma-operator') || ''
op.onchange = () => { localStorage.setItem('lma-operator', op.value.trim()); $('#opHint').textContent = '已保存' }
function operator() { return op.value.trim() }
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.style.background = isErr ? '#b91c1c' : '#111827'; t.style.display = 'block'
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2600)
}
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'X-LMA-Operator': operator(), ...(opts.body ? {'Content-Type':'application/json'} : {}) }, ...opts })
  const j = await r.json().catch(() => ({}))
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
  if (!operator()) return toast('请先在右上角填写操作者名字', true)
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
    '<span class="muted">共 ' + d.total + ' 条 · 第 ' + d.page + '/' + pages + ' 页</span>' +
    (d.page > 1 ? ' <button onclick="gotoPage(' + (d.page - 1) + ')">上一页</button>' : '') +
    (d.page < pages ? ' <button onclick="gotoPage(' + (d.page + 1) + ')">下一页</button>' : '') + '</div>' +
    '<table><tr><th>ID</th><th>公司</th><th>邮箱</th><th>国家</th><th>状态</th><th>匹配度</th><th></th></tr>' + rows + '</table></div>'
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
  const d = await api('/api/send-queue')
  const rows = d.pending.map((q) =>
    '<tr><td>草稿 #' + q.draftId + '</td><td>供应商 #' + q.supplierId + '</td><td>' + fmt(q.dueAtIso) + '</td><td>' + esc(q.reason || '—') + '</td></tr>').join('')
  const p = d.policy
  $('#view').innerHTML = '<div class="stats">' + stat(d.todaySent + ' / ' + p.dailyLimit, '今日已发 / 上限') +
    stat(p.intervalMinutes + ' 分钟', '节流间隔') + stat(p.checkWorkingHours ? (p.workStart + ':00–' + p.workEnd + ':00') : '关闭', '对方工作时段') +
    stat(d.pending.length, '队列中') + '</div>' +
    '<div class="card" style="margin-top:14px"><b>待发队列</b>' +
    (rows ? '<table style="margin-top:8px"><tr><th>草稿</th><th>供应商</th><th>预计发送</th><th>说明</th></tr>' + rows + '</table>'
          : '<p class="muted">队列为空。审核通过后用 lma_send 入队。</p>') + '</div>'
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
  if (!operator()) return toast('请先在右上角填写操作者名字', true)
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
    '<div class="card"><b>发送策略</b><pre>' + esc(JSON.stringify(d.send_policy, null, 2)) + '</pre></div>'
}

// ---------- 框架 ----------
const RENDER = { overview: renderOverview, review: renderReview, suppliers: renderSuppliers, queue: renderQueue, unsub: renderUnsub, config: renderConfig }
function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([id, label]) =>
    '<button class="' + (tab === id ? 'active' : '') + '" onclick="switchTab(\\'' + id + '\\')">' + label + '</button>').join('')
}
window.switchTab = (t) => { tab = t; renderTabs(); RENDER[t]().catch((e) => { $('#view').innerHTML = '<div class="card err">加载失败：' + esc(e.message) + '</div>' }) }
renderTabs()
window.switchTab('overview')
setInterval(() => { if (tab === 'overview' || tab === 'queue') RENDER[tab]().catch(() => {}) }, 15000)
</script>
</body>
</html>`
}

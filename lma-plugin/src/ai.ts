// AI 匹配与邮件生成（PRD 5.5）：mock 规则可离线；api 模式对接 OpenAI 兼容接口（含 DSH/DeepSeek）
// 页脚（来源声明 + 退订链接）由服务端固定追加（F-AI-04/05、F-COMP-01）
import type { Db, ProfileConfig, EmailTemplateConfig, AiConfig } from './db.ts'
import { getProfile, getEmailTemplate, getConfig } from './db.ts'
import { hmac } from './util.ts'

export interface AiRuntime {
  mode: 'mock' | 'api'
  url: string
  key: string
  model: string
}

/**
 * 解析当前生效的 AI 配置（F-AI-06）。
 * **数据库优先**（admin 在网页端「配置」里改，存 app_config.ai_config）：
 * 一旦保存过配置，就完全以库里的为准；从未保存过时才退回环境变量，保持向后兼容。
 */
export function resolveAi(db: Db): AiRuntime {
  const saved = getConfig<Partial<AiConfig> | null>(db, 'ai_config', null)
  if (!saved) {
    return {
      mode: (process.env.LMA_AI_MODE ?? 'mock') === 'api' ? 'api' : 'mock',
      url: (process.env.LMA_AI_URL ?? process.env.AI_API_URL ?? '').replace(/\/+$/, ''),
      key: process.env.LMA_AI_KEY ?? process.env.AI_API_KEY ?? '',
      model: process.env.LMA_AI_MODEL ?? 'deepseek-chat',
    }
  }
  return {
    mode: saved.mode === 'api' ? 'api' : 'mock',
    url: String(saved.url ?? '').replace(/\/+$/, ''),
    key: String(saved.key ?? ''),
    model: String(saved.model || 'deepseek-chat'),
  }
}

export function unsubscribeToken(email: string): string {
  return hmac(process.env.LMA_COOKIE_SECRET ?? 'lma-dev-secret', 'unsub:' + email).slice(0, 24)
}

export interface MatchResult {
  score: number
  analysis: string
}

export interface DraftResult {
  subject: string
  body: string
}

export interface SupplierLike {
  id: number
  company_name: string
  contact_name: string | null
  email: string
  business: string | null
  networks: string | null
  profile: string | null
  country: string | null
  preferred_language: string | null
  source: string | null
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = String(text).match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) as Record<string, unknown> } catch { return null }
}

async function callLlm(ai: AiRuntime, messages: Array<{ role: string; content: string }>, maxTokens = 1200): Promise<string> {
  const res = await fetch(ai.url + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.key}` },
    body: JSON.stringify({ model: ai.model, messages, temperature: 0.4, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`AI 接口返回 ${res.status}`)
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

// ---------- 匹配度评分 + 建议合作切入点（F-AI-02） ----------
export async function matchSupplier(db: Db, supplier: SupplierLike): Promise<MatchResult> {
  const profile = getProfile(db)
  const business = `${supplier.business ?? ''} ${supplier.networks ?? ''} ${supplier.profile ?? ''}`.toLowerCase()

  const ai = resolveAi(db)
  if (ai.mode === 'api' && ai.url && ai.key) {
    const content = await callLlm(ai, [
      { role: 'system', content: '你是国际物流业务拓展顾问。根据"我方画像"与"对方公司资料"，输出 JSON：{"score":0-100整数,"analysis":"合作切入点分析（中文，≤150字）"}。只输出 JSON。' },
      { role: 'user', content: `我方画像：${JSON.stringify(profile)}\n对方公司：${supplier.company_name}，国家 ${supplier.country ?? '未知'}，资料：${JSON.stringify({ business: supplier.business, networks: supplier.networks, profile: supplier.profile })}` },
    ])
    const j = extractJson(content)
    if (j && typeof j.score === 'number') {
      return { score: Math.max(0, Math.min(100, Math.round(j.score))), analysis: String(j.analysis ?? '') }
    }
    throw new Error('AI 返回格式无法解析')
  }

  // mock：关键词重合度 + 目标市场加分
  const pool = [...profile.services, ...profile.strengths, profile.intro]
    .filter(Boolean).map((s) => String(s).toLowerCase())
  const hits = pool.filter((k) => k.length >= 3 && business.includes(k)).length
  let score = 40 + hits * 8
  if (profile.targetMarkets?.includes(supplier.country ?? '')) score += 15
  score = Math.max(5, Math.min(98, Math.round(score)))
  const networks = supplier.networks ? `，WCA 网络：${supplier.networks.slice(0, 120)}` : ''
  const analysis =
    `对方主营${supplier.business ? `“${supplier.business.slice(0, 100)}”` : '信息缺失'}${networks}，` +
    `与我方服务关键词重合 ${hits} 项，` +
    (profile.targetMarkets?.includes(supplier.country ?? '')
      ? `且位于我方目标市场（${supplier.country}），建议优先触达。`
      : `可尝试从其业务相关环节切入。`) +
    `建议切入点：以“${profile.services.slice(0, 2).join('、')}”为引子，强调时效与清关能力。`
  return { score, analysis }
}

// ---------- 邮件页脚（F-COMP-01） ----------
export function buildFooter(db: Db, supplier: SupplierLike, baseUrl: string): string {
  const tpl = getEmailTemplate(db)
  const sourceLine = String(tpl.footerSource).replace('{source}', supplier.source || 'business list')
  // 退订以「回信」为主（F-COMP-01）：回复时在主题写 unsubscribe，由 IMAP 关键词识别自动退订，
  // 不再依赖公网可达的退订页；仅在未配置发件地址时回退到本地 HTTP 端点。
  const replyTo = process.env.LMA_MAIL_FROM ?? process.env.LMA_SMTP_USER ?? ''
  const unsub = replyTo
    ? `To unsubscribe, reply to this email with "unsubscribe" in the subject line, or click: mailto:${replyTo}?subject=Unsubscribe`
    : `To unsubscribe, reply to this email with "unsubscribe" in the subject line. Or visit: ${baseUrl}/unsubscribe?e=${encodeURIComponent(supplier.email)}&t=${unsubscribeToken(supplier.email)}`
  return `\n\n---\n${sourceLine}\n${unsub}`
}

// ---------- 生成个性化推广邮件草稿（F-AI-03） ----------
export async function generateDraft(db: Db, supplier: SupplierLike, match: MatchResult, baseUrl: string): Promise<DraftResult> {
  const profile = getProfile(db)
  const tpl = getEmailTemplate(db)
  const lang = supplier.preferred_language || 'en'

  const ai = resolveAi(db)
  if (ai.mode === 'api' && ai.url && ai.key) {
    const banned = (tpl.bannedWords || []).join(', ')
    const content = await callLlm(ai, [
      { role: 'system', content:
        `你是国际商务邮件撰写专家。输出 JSON：{"subject":"主题","body":"正文（纯文本，不含页脚）"}。硬性要求：
1. 语言：${lang === 'zh' ? '中文' : '英文'}；2. subject ≤ ${tpl.subjectMax} 字符；3. body ≤ ${tpl.bodyMaxWords} 词；
4. 禁用词：${banned}；5. 必须包含明确 CTA；6. 不得编造我方不存在的服务与数据。只输出 JSON。` },
      { role: 'user', content:
        `我方画像：${JSON.stringify(profile)}\n对方：${supplier.company_name}（${supplier.country ?? '未知'}），主营：${supplier.business ?? '未知'}，网络：${supplier.networks ?? '未知'}，介绍：${(supplier.profile ?? '').slice(0, 500)}。\n匹配度 ${match.score}，分析：${match.analysis}` },
    ], 800)
    const j = extractJson(content)
    if (j?.subject && j?.body) {
      const subject = String(j.subject).trim().slice(0, tpl.subjectMax)
      const body = String(j.body).trim()
      // 后置硬校验：禁用词与字数上限不依赖 prompt 自觉（F-AI-04/05）
      const lower = `${subject}\n${body}`.toLowerCase()
      const hit = (tpl.bannedWords || []).find((w) => w && lower.includes(String(w).toLowerCase()))
      if (hit) throw new Error(`AI 草稿包含禁用词「${hit}」，已拒绝落库，请重新生成`)
      if (body.split(/\s+/).filter(Boolean).length > tpl.bodyMaxWords) {
        throw new Error(`AI 草稿正文超过 ${tpl.bodyMaxWords} 词上限，已拒绝落库，请重新生成`)
      }
      return { subject, body }
    }
    throw new Error('AI 返回格式无法解析')
  }

  // mock 模板（en/zh）
  const services = profile.services.slice(0, 3).join(lang === 'zh' ? '、' : ', ')
  const networks = supplier.networks ? (lang === 'zh' ? `（我们注意到贵司为 WCA 网络成员：${supplier.networks.split(';')[0]}）` : ` (We noticed ${supplier.company_name} is a WCA network member: ${supplier.networks.split(';')[0]})`) : ''
  const subject = lang === 'zh'
    ? `合作机会：${supplier.company_name} × ${profile.companyName}`
    : `Partnership opportunity: ${supplier.company_name} × ${profile.companyName}`
  const body = lang === 'zh'
    ? `您好，${supplier.contact_name || supplier.company_name}：

我们从公开渠道了解到贵司主营${supplier.business || '物流相关业务'}${networks}。${profile.companyName} 专注于${services}，依托上海、宁波、深圳口岸与保税仓，在时效与清关方面有成熟经验。

若您有兴趣，欢迎直接回复本邮件，或约定 15 分钟沟通，了解具体合作方式。

祝好，
${profile.companyName}`
    : `Hello ${supplier.contact_name || supplier.company_name},

We understand ${supplier.company_name} is active in ${supplier.business || 'logistics-related services'}${networks}. ${profile.companyName} focuses on ${services}, leveraging China's key ports (Shanghai, Ningbo, Shenzhen) and bonded warehousing, with proven expertise in transit time and customs clearance.

If you are interested, simply reply to this email or let us schedule a quick 15-minute call to explore how we could work together.

Best regards,
${profile.companyName}`
  return { subject: subject.slice(0, tpl.subjectMax), body }
}

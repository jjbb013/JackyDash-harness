// 内置 AI 助手（独立版核心）：仪表盘聊天框 → LLM function calling → 复用同一批业务工具
//
// 替代 dsh Harness Agent 的角色：用户用自然语言提问/下达业务指令，
// 后端调 OpenAI 兼容端点，模型自主选择并执行 lma_* 工具，完成
// "分析发送进程 / 统计数据 / 生成与编辑邮件草稿 / 跟进复盘" 闭环。
//
// mock 模式（未配 AI Key）下不调外部接口，提示先去「配置」页填写端点。
import type { Db } from './db.ts'
import { buildLmaTools, type ToolSpec } from './tools.ts'
import { resolveAi, callLlm, thinkingPayload } from './ai.ts'
import { extractSoulEntry } from './ai.ts'
import { appendSoul } from './soul.ts'
import { PROJECT_KNOWLEDGE } from './knowledge.ts'

const MAX_ROUNDS = 8
const TOOL_RESULT_CHARS = 2000

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** ToolSpec.parameters → OpenAI function 调用的 JSON schema */
function toOpenAiTool(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, p] of Object.entries(spec.parameters)) {
    properties[name] = {
      type: p.type,
      description: p.description,
      ...(p.enum ? { enum: p.enum } : {}),
    }
    if (p.required) required.push(name)
  }
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: { type: 'object', properties, required },
    },
  }
}

function truncate(s: string): string {
  return s.length > TOOL_RESULT_CHARS ? s.slice(0, TOOL_RESULT_CHARS) + `…（已截断，共 ${s.length} 字符）` : s
}

export interface AssistantStep {
  tool: string
  args: Record<string, unknown>
  result: string
}

export interface AssistantResult {
  reply: string
  steps: AssistantStep[]
  mode: 'api' | 'mock'
}

/**
 * 运行一轮 AI 助手对话。
 * @param db - 数据库
 * @param userMessage - 用户输入
 */
/** 判断用户消息是否可能包含对邮件的持久性需求（控制提取成本） */
const SOUL_CHAT_KEYWORDS = ['邮件', '模板', '语气', '风格', '称呼', '开头', '结尾', '署名', 'CTA', '禁用', '希望', '不要', '避免', '记得', '以后', '推广', '正文', '主题']
function chatMayCarrySoulNeed(msg: string): boolean {
  if (msg.length < 12) return false
  return SOUL_CHAT_KEYWORDS.some((k) => msg.includes(k))
}

export async function runAssistant(db: Db, userMessage: string): Promise<AssistantResult> {
  const ai = resolveAi(db)
  const specs = buildLmaTools(db)
  const byName = new Map(specs.map((s) => [s.name, s]))

  if (ai.mode !== 'api' || !ai.url || !ai.key) {
    return {
      reply: '当前 AI 助手为 mock 模式（未配置 AI 端点）。请到仪表盘「配置」页选择 api 模式、填写端点地址与 API Key 后即可使用。\n\n你也可以直接用仪表盘各 tab 完成操作：导入、审核队列、供应商、发送队列、退订名单。',
      steps: [],
      mode: 'mock',
    }
  }

  // soul 记忆：若本次聊天包含对邮件的持久需求，先提炼并落盘，再继续对话
  if (chatMayCarrySoulNeed(userMessage)) {
    const rule = await extractSoulEntry(db, `用户在 AI 聊天中表达了对邮件生成的长期需求：${userMessage}`).catch(() => null)
    if (rule) appendSoul(db, { type: 'chat', at: new Date().toISOString().slice(0, 10), text: rule })
  }

  const tools = specs.map(toOpenAiTool)
  const system = [
    '你是 LMA 物流推广智能体系统的 AI 运营助手，服务于 3~5 人的国际物流业务团队。',
    '你可以调用工具完成：查询统计总览、查看供应商与匹配分析、生成邮件草稿、审核与发送、跟进检查、导出名单、维护退订名单与系统配置。',
    '工作原则：',
    '1. 涉及发信/审核/配置变更时，先说明你将做什么再调用工具；',
    '2. 统计类问题直接调工具取数，不要凭空估算；',
    '3. 邮件编辑类需求：先用 lma_match 分析供应商，再 lma_draft 生成草稿，然后引导用户到「审核队列」人工确认后再发送；',
    '4. 退订/合规类操作必须确认是客户明确要求；',
    '5. 回答用中文，简洁，关键数字用表格或列表。',
    '',
    '项目知识备查（用户问系统怎么用时可参考）：',
    typeof PROJECT_KNOWLEDGE.overview === 'string' ? PROJECT_KNOWLEDGE.overview.slice(0, 1500) : '',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userMessage },
  ]
  const steps: AssistantStep[] = []

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(ai.url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.key}` },
      body: JSON.stringify({
        model: ai.model,
        messages: messages.map(({ role, content, ...rest }) => ({ role, content, ...rest })),
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 1200,
        ...thinkingPayload(ai),
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`AI 接口返回 ${res.status}：${text.slice(0, 200)}`)
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
    }
    const msg = data.choices?.[0]?.message
    if (!msg) throw new Error('AI 接口未返回内容')

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    }
    messages.push(assistantMsg)

    const calls = msg.tool_calls ?? []
    if (calls.length === 0) {
      return { reply: msg.content ?? '(AI 未返回文本)', steps, mode: 'api' }
    }

    for (const call of calls) {
      const spec = byName.get(call.function.name)
      let result: string
      if (!spec) {
        result = JSON.stringify({ error: `未知工具 ${call.function.name}` })
      } else {
        let args: Record<string, unknown> = {}
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {} }
        catch { result = JSON.stringify({ error: '工具参数不是合法 JSON' }) }
        if (typeof result !== 'string') {
          try {
            const out = await spec.execute(args)
            result = typeof out === 'string' ? out : JSON.stringify(out)
          } catch (e) {
            result = JSON.stringify({ error: (e as Error).message })
          }
        }
      }
      steps.push({ tool: call.function.name, args: {}, result: truncate(result) })
      messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(result) })
    }
  }

  return {
    reply: `已完成 ${steps.length} 步操作（${steps.map((s) => s.tool).join('、')}）。如需进一步分析，请继续提问。`,
    steps,
    mode: 'api',
  }
}

// dsh 插件桥接：把与框架无关的 ToolSpec 包成 defineTool（ToolDefinition），
// 注册到 ctx.tools。独立版（main.ts + assistant.ts）不引用本文件。
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolSpec } from './tools.ts'

/** 单个 ToolSpec → defineTool 定义：schema 参数校验 + 输出 render */
export function toDshTool(spec: ToolSpec): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters as never,
    output: {
      schema: { type: 'string' } as never,
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      try {
        const out = await spec.execute(args as Record<string, unknown>)
        return (typeof out === 'string' ? out : JSON.stringify(out, null, 2)) as never
      } catch (e) {
        throw new Error(`[${spec.name}] ${(e as Error).message}`)
      }
    },
  }) as ToolDefinition
}

/** 批量包装 */
export function toDshTools(specs: ToolSpec[]): ToolDefinition[] {
  return specs.map(toDshTool)
}

// 仪表盘页面回归测试：把内联 <script> 抽出来做**语法编译**
//
// 为什么需要它：page.ts 是一个巨大的 TS 模板字符串，里面写的是浏览器 JS。
// 模板字符串会把 `\/` 还原成 `/`，于是 `replace(/^\//,'')` 会生成 `replace(/^//,'')`
// —— 语法错误，整个仪表盘脚本失效，而**任何只做服务端 API 的测试都发现不了**（真实踩过）。
import { describe, expect, it } from 'vitest'
import { dashboardPage } from '../src/web/page.ts'

const extractScript = (html: string): string => {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('页面里找不到内联 <script>')
  return m[1]
}

describe('仪表盘页面（内联 JS 语法与角色化 UI）', () => {
  const adminHtml = dashboardPage({ username: 'alice', role: 'admin', mustChangePassword: false })
  const staffHtml = dashboardPage({ username: 'bob', role: 'staff', mustChangePassword: false })

  it('内联 JS 必须能被编译（语法错误会让整个仪表盘失效）', () => {
    expect(() => new Function(extractScript(adminHtml))).not.toThrow()
    expect(() => new Function(extractScript(staffHtml))).not.toThrow()
  })

  it('内联 JS 里不出现被模板字符串吃掉的转义（如 /^// ）', () => {
    const js = extractScript(adminHtml)
    // 生成的代码里不应有空的或明显残缺的正则字面量
    expect(js).not.toMatch(/replace\(\/\^\/\//)
    expect(js).not.toContain('/^//')
  })

  it('注入当前用户与角色，且不再有手填的"操作者"输入框', () => {
    expect(adminHtml).toContain('"username":"alice"')
    expect(adminHtml).toContain('"role":"admin"')
    expect(staffHtml).toContain('"role":"staff"')
    expect(adminHtml).not.toContain('id="operator"')
    expect(adminHtml).toContain('id="whoami"')
    expect(adminHtml).toContain('id="logout"')
  })

  it('首登强制改密表单存在', () => {
    expect(dashboardPage({ username: 'x', role: 'staff', mustChangePassword: true })).toContain('首次登录，请先修改密码')
  })

  it('业务动作按钮齐全（发送 / 跟进 / 导出 / 导入 / AI 配置 / 人员管理）', () => {
    for (const marker of ['data-act="send"', 'data-act="followup"', 'data-act="export"', 'data-act="imp-preview"', 'data-act="save-ai"', "'users', '人员管理', 'admin'"]) {
      expect(adminHtml, `缺少 ${marker}`).toContain(marker)
    }
  })

  it('管理员专属 tab 标注了所需角色（前端按角色过滤）', () => {
    expect(adminHtml).toContain("'config', '配置', 'admin'")
    expect(adminHtml).toContain('visibleTabs')
  })

  it('所有请求走相对路径（支持反代挂在 /lma 子路径）', () => {
    const js = extractScript(adminHtml)
    // helper 负责剥掉前导斜杠，因此调用点写 api('/api/xxx') 也是相对请求
    expect(js).toContain("charAt(0) === '/' ? String(path).slice(1)")
    // 但不能有绕过 helper 的绝对路径请求
    expect(js).not.toContain("fetch('/api/")
    expect(js).not.toContain('fetch("/api/')
    expect(js).not.toContain("location.href = '/api/")
  })
})

// 项目知识库：让 Harness Agent 能"完全理解项目"并协助私有化定制任务
// 内容与 PRD v1.2 对齐，Agent 通过 lma_project_knowledge 工具按需获取
export const PROJECT_KNOWLEDGE: Record<string, string> = {
  overview: `# LMA 物流推广智能体系统（基于 DeepSeek Harness 二开的插件）

## 是什么
面向海外物流企业的内部邮件推广系统。基于导入的客户名单做业务匹配分析、生成个性化推广邮件，经人工审核后发送，并追踪回复与跟进状态。
底层是 DeepSeek Harness（DSH），本插件（lma-plugin）以"工具集 + 插件内定时任务 + SQLite"的形态实现全部业务，不改动 Harness 仓库代码。

## 技术栈与部署约束
- 单机 1 核 2G 公网 IP；Node 22 + SQLite（node:sqlite 内置，零原生依赖）+ 应用内调度
- 3 人使用（1 admin + 2 staff），日均发送 10~20 封
- 加载方式：pnpm dsh web --patch ./lma-plugin/cordis.yml

## 核心流程
CSV 导入（可插拔适配器）→ 统一入库管道（映射→校验→规范化→去重→入库→日志）→ 按需 AI 匹配 → 个性化邮件生成 → 人工审核（批准/改后批准/驳回）→ 发送队列（3 分钟节流、每日上限、对方工作时段）→ IMAP 轮询（回复/退信/退订）→ 人工跟进

## 关键控制点
1. 入库管道：所有外部数据必须经过统一校验和去重
2. 审核闸门：初期所有邮件必经人工（F-REVIEW-01~04）
3. 合规四件事：退订实时生效、来源可追溯、来源声明+退订链接、审计日志

## 你能做什么
通过 lma_* 工具完成：导入/导出名单、查询供应商、AI 匹配与生成草稿、审核、发送、追踪回复/退信/退订、配置业务画像与发送策略、查审计日志、处理跟进。

## 推荐操作
- 用户要导入名单 → lma_import_preview → lma_import_confirm（记得问清 source_note 来源备注）
- 用户要发邮件 → lma_draft → lma_review_queue → lma_review 批准 → lma_send
- 用户问怎么用/合规 → lma_project_knowledge topic=compliance
- 发送前务必用 lma_unsubscribes 确认不在退订名单；退订名单发送前必查且实时生效`,
  import: `# CSV 导入
- 流程：lma_import_preview（解析+自动映射+校验统计，返回 batch_id）→ lma_import_confirm（确认导入）
- 支持列名（含 WCA 模板）：company/company_name、emails/email、contacts/contact_name、networks、profile、country、city/region、address、phone/fax、website、enrolled_since、id
- emails 与 networks 为分号分隔多值，自动拆分
- 国家 → 时区自动推断（如 Netherlands → NL → Europe/Amsterdam），语言默认 en
- 必填：公司名称、邮箱；单次 ≤ 5000 行；文件 UTF-8（兼容 BOM）
- 合规必填 source_note（数据来源备注），写入 source 字段用于溯源
- 重复策略：skip 跳过 / update 更新已有 / create 新建
- 失败行有明细（行号+原因），可修正后重新导入`,
  export: `# 数据导出
- lma_export_csv：按国家/状态/关键词筛选导出，返回带 BOM 的 CSV（Excel 直接打开不乱码）
- 导出包含状态、最后联系时间等业务字段，用于备份/交接/外部处理
- 每次导出记录 export_log 与审计日志
- 数据自主：名单可随时完整导出，不被系统锁定`,
  match: `# AI 匹配
- lma_match 按需触发（非实时常驻）：对比我方（Transtar）业务画像与对方资料
- 输出：匹配度评分 0-100 + 建议合作切入点，写入 supplier.match_score/match_analysis
- mock 模式：服务关键词重合度 + 目标市场加分（NL/DE/GB/US/AU/SG/FR/BE/IT/ES）
- api 模式：LMA_AI_MODE=api + LMA_AI_URL/LMA_AI_KEY/LMA_AI_MODEL（OpenAI 兼容）`,
  draft: `# 邮件生成
- lma_draft：按对方首选语言生成个性化草稿；页脚自动附加来源声明与退订链接（服务端强制，不可删）
- 硬限制：主题 ≤ 80 字符、正文 ≤ 250 词、禁用词、必须含明确 CTA（F-AI-04/05）
- 草稿进入审核队列（status=draft）`,
  review: `# 人工审核（F-REVIEW）
- lma_review_queue 查看待审队列；lma_review 审批
- 动作：approve（批准）/ approve_with_edit（改后批准，需新 subject/body）/ reject（驳回，需 reason）
- 审核人与审核时间自动留痕；仅 approved 可发送（F-SEND-02）`,
  send: `# 邮件发送（F-SEND）
- lma_send 将 approved 草稿入队。发送前自动检查（顺序）：
  1. 退订名单实时查询（F-COMP-02）
  2. 邮箱格式 + 供应商状态
  3. 每日上限（默认 20，超限排至次日 9:00）
  4. 节流：每封间隔约 3 分钟（F-SEND-04）
  5. 对方当地时间工作时段（默认 9:00-18:00，非工作日/非工作时段排队，F-SEND-06）
- SMTP：LMA_SMTP_HOST/PORT/USER/PASS/MAIL_FROM；未配置时 log 模式（仅记录事件，不发真邮件）
- 事件：sent/delivered/replied/bounced/unsubscribed 全部落 email_event`,
  track: `# 回复与跟进（F-TRACK）
- IMAP 每 5 分钟轮询（LMA_IMAP_ENABLED=true + LMA_IMAP_HOST/USER/PASS）
- 回复 → 供应商标记 replied（需人工处理），停止自动跟进
- 退信 → 标记 invalid；退订关键词（unsubscribe/opt out/退订）→ 自动加入退订名单并停止一切发送
- 无 IMAP 时可用 lma_event_record 人工补录事件（管理员）
- 跟进规则：3 天未回发 1 封跟进，最多 2 封；默认只生成草稿（autoFollowup=false），人工批准后发送`,
  compliance: `# 合规要求（核心，按重要性）
1. 退订实时生效：unsubscribe_list 独立表，所有发送前必查（F-COMP-02）
2. 来源可追溯：每条数据带 source 字段 + 导入日志（F-COMP-04）
3. 来源声明 + 退订链接：每封邮件底部固定包含（F-COMP-01）
4. 审计日志：导入/导出/审核/发送/退订处理全部留痕（F-COMP-03）
依据：新西兰《Unsolicited Electronic Messages Act 2007》；Information Privacy Principle 3A（2026-05-01 生效，第三方来源信息须主动通知当事人）。
提醒：CSV 导入同样受约束，必须能说清数据合法来源；正式发送前建议咨询新西兰本地法律顾问。
KPI 以回复率为准（打开率因客户端预加载虚高）。`,
  config: `# 配置（lma_config_get / lma_config_update，管理员）
- profile：我方业务画像（Transtar 八大服务+四大优势+目标市场）
- email_template：页脚来源声明（{source} 占位）、禁用词、主题/正文上限
- send_policy：interval_minutes（默认 3）、daily_limit（默认 20）、check_working_hours（默认 true）、work_start/work_end（9/18）、auto_followup（默认 false）、followup_after_days（3）、followup_max（2）
- 角色权限（PRD 三、用户角色），判定逻辑收敛在 src/roles.ts：
  · admin（管理员，LMA_ADMINS 环境变量，逗号分隔操作者名）：导入/导出数据、配置、管理账号、维护业务画像、审核、发送、看统计
  · staff（业务伙伴，LMA_STAFF 环境变量）：查看列表、审核邮件、发送、标记跟进、导出数据
  · CSV 导入仅 admin；导出 admin 与 staff 均可；不在任何名单里的操作者，写操作一律拒绝
  · 供应商增删改与退订名单维护为 admin 专属；两种角色共用同一页面，前端按角色控制按钮可见性`,
}

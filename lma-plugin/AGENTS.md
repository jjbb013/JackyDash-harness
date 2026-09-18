# AGENTS.md — LMA 物流推广智能体系统插件

本目录是 DeepSeek Harness 仓库内的**业务插件包**（二开产物）。任何 Agent 在此目录内工作前，请先通读本文件与 `src/knowledge.ts`（`lma_project_knowledge` 工具的内容源）。核心原则：**不修改仓库 `packages/`、`apps/` 等任何 Harness 本体代码**，所有业务都在本插件内实现。

## 项目一句话

一套面向海外物流企业的内部邮件推广系统：导入名单（CSV/未来爬虫走同一管道）→ 匹配分析 → 个性化邮件生成 → 人工审核 → 节流发送 → 追踪回复/退信/退订 → 跟进，退订/溯源/声明/审计四件合规做扎实。

## 关键事实（做任何改动前必须知道）

- **技术约束**：单机 1 核 2G；Node 22；SQLite 用 `node:sqlite`（内置 `DatabaseSync`，零原生依赖，禁止引入 better-sqlite3）；不发真邮件时用 log 模式；IMAP/nodemailer 为可选依赖（`try/catch` 动态导入，缺了自动降级）。
- **⚠️ 发信/收信的假成功陷阱**：`mailer.ts` 的 `smtpConfigured()` 只看环境变量，**不看 `nodemailer` 是否真的加载成功**。填了 `LMA_SMTP_*` 却没装 nodemailer 时，事件仍写成 `mode:"smtp"` 但 `messageId` 为 `null`——实际没发出去。判断是否真发，必须同时看 `mode` 与 `messageId`。IMAP 同理需要 `imapflow`。
- **⚠️ 环境变量在模块加载时读取**（`mailer.ts`/`imap.ts` 顶层 `const`），改 `LMA_SMTP_*`/`LMA_IMAP_*`/`LMA_BASE_URL` 后**必须重启 `dsh web`**才生效。
- **业务硬限制（来自 PRD v1.2）**：单次导入 ≤5000 行；发送节流每封约 3 分钟（可配）、每日上限（默认 20）；对方当地时间 9-18 非工作时段排队；IMAP 每 5 分钟轮询；跟进 3 天×最多 2 封（默认只生成草稿，`autoFollowup=false`）；退订名单所有发送前必查且实时生效；页脚来源声明 + 退订方式由服务端固定追加；仅 `approved` 草稿可发送。
- **退订是回信制**：页脚与 `List-Unsubscribe` 都是 `mailto:`（回复时把 `unsubscribe`/`退订` 写在**主题**里），由 IMAP 关键词识别自动退订；HTTP `/unsubscribe` 端点仅在未配发件地址时兜底。改 `classify()`/`UNSUB_KEYWORDS` 必须同步 `business.spec.ts` 的分类断言。
- **字段/数据模型**：适配 WCA 导出模板——`emails`/`contacts`/`networks` 分号多值（主邮箱取第一个，其余存 `extra_emails` JSON）、`profile` 长文本、`city` 含邮编存 `region`、`id` 存 `external_id`、`enrolled_since` 直存；`Netherlands` → `NL` → `Europe/Amsterdam`；语言默认 `en`。
- **我方画像**：Shanghai Transtar International Freight Forwarding Co., Ltd.（2022 年成立；八大服务：清关合规/多式联运/保税智慧仓 5万㎡/集拼/项目物流/门到门/冷链与 ISO TANK/贸易咨询；优势：本土化、100+ 承运商成本、AI TMS、24/7 双语；目标市场 NL/DE/GB/US/AU/SG/FR/BE/IT/ES）。画像在 `db.ts` 默认值，可经 `lma_config_update` 覆盖。
- **角色与身份（PRD 三）**：角色判定收敛在 `src/roles.ts`，**账号唯一来源是 `lma_user` 表**（无自助注册）。
  - Web 层：Cookie → 会话 → 用户，角色实时读库（禁用/改角色立即生效）
  - 工具层：**服务身份**（`LMA_AGENT_USER`，角色取自 `lma_user`）。**工具的 schema 里已删除 `operator` 参数** ——
    身份由服务端固定，因为 DSH 的工具上下文拿不到"人"（`agent.id` 只是聊天会话 id）。
    ⚠️ **绝不要重新引入可从参数指定身份的设计**，那等于让模型自封 admin。
  - 仅 admin：`lma_import_confirm`、`lma_config_update`、`lma_event_record`、`lma_supplier_edit`、`lma_supplier_delete`
  - admin 或 staff：`lma_review`、`lma_send`、`lma_followup_check`、`lma_export_csv`、`lma_unsubscribe_add`
  - Web 的 `/api/*` 走 `web/api.ts` 的 `ROUTE_ROLES` **白名单**：未登记 404、角色不符 403 + 审计
  - 引导：`lma_user` 为空时启动创建 admin（`LMA_ADMIN_USER`/`LMA_ADMIN_PASSWORD`），库非空绝不复写
  - 测试：身份用 `test-agent`；切角色用 `setAgent('staff')`，越权断言错误文本含「管理员」

- **字段/数据模型**：适配 WCA 导出模板——`emails`/`contacts`/`networks` 分号多值（主邮箱取第一个，其余存 `extra_emails` JSON）、`profile` 长文本、`city` 含邮编存 `region`、`id` 存 `external_id`、`enrolled_since` 直存；`Netherlands` → `NL` → `Europe/Amsterdam`；语言默认 `en`。
- **我方画像**：Shanghai Transtar International Freight Forwarding Co., Ltd.（2022 年成立；八大服务：清关合规/多式联运/保税智慧仓 5万㎡/集拼/项目物流/门到门/冷链与 ISO TANK/贸易咨询；优势：本土化、100+ 承运商成本、AI TMS、24/7 双语；目标市场 NL/DE/GB/US/AU/SG/FR/BE/IT/ES）。画像在 `db.ts` 默认值，可经 `lma_config_update` 覆盖。
- **角色模型（PRD 三）**：`admin` = `LMA_ADMINS`，`staff` = `LMA_STAFF`（都是逗号分隔的操作者名单，模块加载时读取）。**判定收敛在 `src/roles.ts` 一处**，`tools.ts` 与 `web/api.ts` 共用。
  - 仅 admin：`lma_import_confirm`（CSV 导入）、`lma_config_update`、`lma_event_record`、`lma_supplier_edit`、`lma_supplier_delete`、`lma_unsubscribe_add`
  - admin 或 staff：`lma_review`、`lma_send`、`lma_followup_check`、`lma_export_csv`
  - **新增有权限要求的工具必须调 `requireAdmin` / `requireUser`**（`tools.ts` 里的薄封装），并补 `harness.spec.ts` 的「角色权限」用例。测试里 admin 用 `test-admin`、staff 用 `test-staff`、越权用 `outsider`。
  - ⚠️ 不在任何名单里的操作者（含默认的 `harness-agent`）写操作会被拒绝——**有权限要求的工具必须显式传 `operator`**。
- **共享实现（改一处即改两条路径）**：`importing.ts`（CSV 导入预览/确认，工具与网页共用）、
  `exporter.ts`（名单导出）、`sendqueue.ts#requestSend`（发送守卫）、`roles.ts`（角色判定）。
  **新增业务动作时不要在 tools.ts 和 web/api.ts 各写一份守卫**，抽到共享模块里。
- **AI 配置**：`app_config.ai_config`（admin 在网页「配置」里改，支持任意 OpenAI 兼容端点）。
  `ai.ts#resolveAi(db)` 是唯一解析点：**库里有配置就完全以库为准**，从未保存过才退回 `LMA_AI_*`。
  接口永不回传 Key 明文。
- **数据流**：所有外部数据必须经过 `csvpipeline.ts` 的统一管道（映射→校验→规范化→去重→入库→`import_log`），禁止绕过管道直写 `supplier` 表（`lma_supplier_edit` 等白名单字段除外）。

## 架构地图

```
src/index.ts ── openDb(迁移) + seedDefaults + 注册工具 + ctx.effect 定时器
   │                │                    │
   ├── db.ts        ├── tools.ts         ├── sendqueue.processDue（15s）
   │                │   (23 个 defineTool)│── imap.startImapPolling（5min，可选）
   ├── csvpipeline  │   ↓ ctx.tools      └── followup.checkFollowups（6h）
   ├── ai.ts        │
   ├── mailer/sendqueue/imap/followup ─── 后台定时任务直接调用
   └── knowledge.ts（Agent 知识源）
```

## 测试

`pnpm vitest run --config lma-plugin/vitest.config.ts`（mock 模式，无需密钥）。当前基线 **106/106**。
`tests/harness.spec.ts` 证明插件在 dsh 内可加载可执行（`new Context()` + `ctx.plugin(SystemPrompt)` + `ctx.plugin(ToolRuntime)` + `ctx.tools.register(buildLmaTools(db))` + `ctx.tools.execute(...)`）。
新增工具必须在此文件登记断言；改导入管道必须跑真实 `wca_netherlands.csv` 夹具用例。

## 环境变量

见 `README.md` §四。测试默认 `LMA_ADMINS=test-admin`、`LMA_AI_MODE=mock`、SMTP/IMAP 关闭。

## 常见任务指引

- **加一个工具**：`tools.ts` 用 `textTool({name:'lma_xxx', parameters, execute})` 追加 → `buildLmaTools` 数组里加一项 → harness.spec 加断言 → 重启插件生效。
- **换 LLM 供应商**：`LMA_AI_URL`（OpenAI 兼容 `/chat/completions`）+ `LMA_AI_KEY` + `LMA_AI_MODEL`，`ai.ts` 的 `callLlm` 不变。
- **加爬虫数据源**：在 `csvpipeline` 入口产出 `{columns, rows}` 复用管道（PRD 可插拔适配器）。
- **排查**：`audit_log` 与 `import_log` 全量留痕；`email_event` 记录每封邮件的 sent/replied/bounced/unsubscribed。

# AGENTS.md — LMA 物流推广智能体系统插件

本目录是 DeepSeek Harness 仓库内的**业务插件包**（二开产物）。任何 Agent 在此目录内工作前，请先通读本文件与 `src/knowledge.ts`（`lma_project_knowledge` 工具的内容源）。核心原则：**不修改仓库 `packages/`、`apps/` 等任何 Harness 本体代码**，所有业务都在本插件内实现。

## 项目一句话

一套面向海外物流企业的内部邮件推广系统：导入名单（CSV/未来爬虫走同一管道）→ 匹配分析 → 个性化邮件生成 → 人工审核 → 节流发送 → 追踪回复/退信/退订 → 跟进，退订/溯源/声明/审计四件合规做扎实。

## 关键事实（做任何改动前必须知道）

- **技术约束**：单机 1 核 2G；Node 22；SQLite 用 `node:sqlite`（内置 `DatabaseSync`，零原生依赖，禁止引入 better-sqlite3）；不发真邮件时用 log 模式；IMAP/nodemailer 为可选依赖（`try/catch` 动态导入，缺了自动降级）。
- **业务硬限制（来自 PRD v1.2）**：单次导入 ≤5000 行；发送节流每封约 3 分钟（可配）、每日上限（默认 20）；对方当地时间 9-18 非工作时段排队；IMAP 每 5 分钟轮询；跟进 3 天×最多 2 封（默认只生成草稿，`autoFollowup=false`）；退订名单所有发送前必查且实时生效；页脚来源声明+退订链接服务端固定追加；仅 `approved` 草稿可发送。
- **字段/数据模型**：适配 WCA 导出模板——`emails`/`contacts`/`networks` 分号多值（主邮箱取第一个，其余存 `extra_emails` JSON）、`profile` 长文本、`city` 含邮编存 `region`、`id` 存 `external_id`、`enrolled_since` 直存；`Netherlands` → `NL` → `Europe/Amsterdam`；语言默认 `en`。
- **我方画像**：Shanghai Transtar International Freight Forwarding Co., Ltd.（2022 年成立；八大服务：清关合规/多式联运/保税智慧仓 5万㎡/集拼/项目物流/门到门/冷链与 ISO TANK/贸易咨询；优势：本土化、100+ 承运商成本、AI TMS、24/7 双语；目标市场 NL/DE/GB/US/AU/SG/FR/BE/IT/ES）。画像在 `db.ts` 默认值，可经 `lma_config_update` 覆盖。
- **角色模型**：`admin`/`staff` 由 `LMA_ADMINS` 环境变量区分的操作者名单体现（插件运行于 Harness 内，登录由 Harness 负责）。写操作工具（导入/配置/补录事件/跟进/退订处理）校验 `args.operator ∈ LMA_ADMINS`，测试里用 `test-admin`。
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

`pnpm vitest run --config lma-plugin/vitest.config.ts`（mock 模式，无需密钥）。
`tests/harness.spec.ts` 证明插件在 dsh 内可加载可执行（`new Context()` + `ctx.plugin(SystemPrompt)` + `ctx.plugin(ToolRuntime)` + `ctx.tools.register(buildLmaTools(db))` + `ctx.tools.execute(...)`）。
新增工具必须在此文件登记断言；改导入管道必须跑真实 `wca_netherlands.csv` 夹具用例。

## 环境变量

见 `README.md` §四。测试默认 `LMA_ADMINS=test-admin`、`LMA_AI_MODE=mock`、SMTP/IMAP 关闭。

## 常见任务指引

- **加一个工具**：`tools.ts` 用 `textTool({name:'lma_xxx', parameters, execute})` 追加 → `buildLmaTools` 数组里加一项 → harness.spec 加断言 → 重启插件生效。
- **换 LLM 供应商**：`LMA_AI_URL`（OpenAI 兼容 `/chat/completions`）+ `LMA_AI_KEY` + `LMA_AI_MODEL`，`ai.ts` 的 `callLlm` 不变。
- **加爬虫数据源**：在 `csvpipeline` 入口产出 `{columns, rows}` 复用管道（PRD 可插拔适配器）。
- **排查**：`audit_log` 与 `import_log` 全量留痕；`email_event` 记录每封邮件的 sent/replied/bounced/unsubscribed。

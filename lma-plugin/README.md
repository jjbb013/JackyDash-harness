# LMA 物流推广智能体系统（DeepSeek Harness 二开插件）

基于 PRD v1.2 定稿实现。**不改动 Harness 仓库代码**：以 Cordis 插件（`name + apply(ctx)`）形态开发，加载后注册一组 `lma_*` 工具 + 插件内定时任务 + SQLite 数据层，Harness Agent 通过工具集即可完成全部业务与私有化定制任务。

## 一、这是什么

| 项 | 说明 |
|---|---|
| 业务 | 面向海外物流企业的内部邮件推广系统：CSV 导入 → 统一入库管道 → AI 匹配 → 个性化邮件生成 → 人工审核 → 节流发送 → IMAP 追踪回复/退信/退订 → 跟进 |
| 形态 | dsh 插件包（本目录 `lma-plugin/`），不 fork、不改 `packages/*` |
| 技术 | Node 22 + SQLite（`node:sqlite` 内置，零原生依赖，WAL）+ 应用内调度；nodemailer/imapflow 为可选依赖（未装自动降级） |
| 合规 | 退订实时生效、来源可追溯、页脚来源声明+退订链接、全流程审计日志 |
| 部署约束 | 单机 1 核 2G 公网 IP；3 人（admin+2 staff）；日均 10~20 封；无专职运维 |

## 二、目录结构

```
lma-plugin/
├── package.json          # @lma/dsh-plugin（已登记进仓库 pnpm-workspace.yaml）
├── cordis.yml            # dsh web --patch 加载补丁（name 必须是绝对路径）
├── vitest.config.ts      # 本地测试配置（mock 模式）
├── src/
│   ├── index.ts          # 插件入口：开库+迁移+seed、注册 23 个工具、ctx.effect 定时任务
│   ├── db.ts             # node:sqlite 建表/迁移、配置读写、Transtar 画像默认值
│   ├── csvparse.ts       # 自研流式 RFC4180 解析器（BOM/引号/CRLF/行数上限）
│   ├── csvpipeline.ts    # 统一入库管道：字段映射→校验→规范化→去重→入库→日志
│   ├── ai.ts             # 匹配评分+草稿生成（mock 离线 / api 对接 OpenAI 兼容）
│   ├── mailer.ts         # nodemailer SMTP（可选），未配置时 log 模式
│   ├── sendqueue.ts      # 内存发送队列：3 分钟节流/每日上限/工作时段/退订硬查
│   ├── imap.ts           # IMAP 每 5 分钟轮询：回复/退信/退订关键词识别
│   ├── followup.ts       # 跟进规则：3 天×最多 2 封（默认只生成草稿）
│   ├── timezone.ts       # 国家→时区推断、当地时间、工作时段
│   ├── audit.ts          # 审计日志
│   ├── knowledge.ts      # 项目知识库（Agent 通过 lma_project_knowledge 获取）
│   ├── tools.ts          # 23 个 lma_* 工具（defineTool 定义，ctx.tools.register 注册）
│   ├── unsubscribe.ts    # 退订 token 校验 + 幂等退订（供 Web 服务与独立端点复用）
│   ├── web/
│   │   ├── server.ts     # LMA Web 服务：/ 仪表盘 + /unsubscribe + /api/*（绑 127.0.0.1）
│   │   ├── api.ts        # JSON API：总览/供应商/审核队列/发送队列/退订名单/配置
│   │   └── page.ts       # 仪表盘单文件 HTML（内联 CSS/JS，6 个 tab，15s 轮询）
│   └── client/
│       └── index.tsx     # dsh 客户端插件：slots.inject 注册顶部「LMA 推广」入口（iframe 嵌仪表盘）
├── tsconfig.client.json   # 客户端 tsc 投影（src/client → lib/types）
└── tsdown.config.ts       # 客户端 bundle 打包（lib/client.js，ModuleLoader 握手）
└── tests/                # vitest：业务级 + Harness 集成（Context+SystemPrompt+ToolRuntime）
```

## 三、安装与加载

```bash
cd /path/to/deepseek-harness
pnpm install          # lma-plugin 已加入 pnpm-workspace.yaml，依赖随仓库一起装
pwd                   # 复制仓库绝对路径
```

把 `lma-plugin/cordis.yml` 中的 `name` 改为你机器的绝对路径（指向 `lma-plugin/src/index.ts`），然后：

```bash
pnpm dsh web --patch ./lma-plugin/cordis.yml
```

启动日志出现 `[lma] LMA 物流推广智能体系统插件已加载` 即成功。Web UI：`http://127.0.0.1:3080`。Web UI 里直接让 Agent 做业务即可（例如："导入工作区的 wca_netherlands.csv，来源备注 WCA 2026-09 导出，重复策略 skip"）。

### Web 仪表盘（dsh web 顶部入口）

插件带一个独立的 Web 仪表盘，并在 dsh web 侧边栏顶部注册「LMA 推广」全局面板入口（客户端插件机制，不改 Harness 本体）：

- 打开 `http://127.0.0.1:3080`，侧边栏顶部点击 **LMA 推广** 图标，主区即嵌入仪表盘（iframe → `http://127.0.0.1:3081/`）
- 也可直接访问 `http://127.0.0.1:3081/`（六个 tab：总览 / 审核队列 / 供应商 / 发送队列 / 退订名单 / 配置）
- 写操作（审核批准/驳回、手动添加退订）要求右上角填写的操作者 ∈ `LMA_ADMINS`，写请求带 `X-LMA-Operator` 头，服务端校验并记审计
- 只读 API（`GET /api/overview|suppliers|supplier|review-queue|send-queue|unsubscribes|config`）无需身份——服务默认只绑 127.0.0.1

客户端 bundle 构建（改了 `src/client/` 之后需要重跑）：

```bash
pnpm --filter @lma/dsh-plugin run build:client   # tsc → lib/types，tsdown → lib/client.js
```

## 四、环境变量（全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LMA_DB_PATH` | `<仓库根>/lma-data/lma.db` | SQLite 路径 |
| `LMA_DB_BACKUP_DIR` | 空（不备份） | 每日备份目录（保留 14 份） |
| `LMA_ADMINS` | 空 | 管理员操作者名单（逗号分隔）。**写操作（导入/审核/发送/配置/补录事件/跟进）会校验，非管理员被拒绝** |
| `LMA_OPERATOR` | `harness-agent` | 工具未传 operator 时默认审计操作者 |
| `LMA_BASE_URL` | `http://127.0.0.1:3081` | 退订链接域名（须指向本插件 Web 服务；生产改成你的 HTTPS 域名并反代到 `LMA_HTTP_PORT`） |
| `LMA_HTTP_PORT` | `3081` | 插件内置 Web 服务端口：`/` 仪表盘、`/unsubscribe` 退订端点、`/api/*` JSON API（绑 127.0.0.1，Node 原生 http，零依赖） |
| `LMA_COOKIE_SECRET` | `lma-dev-secret` | 退订 token HMAC 密钥 |
| `LMA_AI_MODE` | `mock` | `mock` 离线规则 / `api` 对接 OpenAI 兼容接口 |
| `LMA_AI_URL` / `LMA_AI_KEY` / `LMA_AI_MODEL` | 空 / 空 / `deepseek-chat` | api 模式必填（也兼容任意 OpenAI 兼容服务） |
| `LMA_SMTP_HOST/PORT/SECURE/USER/PASS` | 空 | 填了走真实 SMTP；不填走 log 模式（只记录事件） |
| `LMA_MAIL_FROM` | SMTP_USER | 发件人 |
| `LMA_IMAP_ENABLED/HOST/PORT/TLS/USER/PASS` | false / 空 | `LMA_IMAP_ENABLED=true` 开启每 5 分钟轮询 |
| `LMA_AI_URL` 未配且 `LMA_AI_KEY` 为空 | — | mock 模式，无需任何密钥即可本地跑通 |

## 五、工具清单（模型可调用）

`lma_dashboard` `lma_import_preview` `lma_import_confirm` `lma_import_logs` `lma_export_csv`
`lma_suppliers` `lma_supplier_detail` `lma_supplier_edit` `lma_supplier_delete`
`lma_match` `lma_draft` `lma_review_queue` `lma_review` `lma_send` `lma_send_queue`
`lma_events` `lma_event_record` `lma_unsubscribes` `lma_unsubscribe_add`
`lma_config_get` `lma_config_update` `lma_followup_check` `lma_project_knowledge`

典型会话（Agent 自动完成）：
1. `lma_import_preview {path: "/workspace/xx.csv"}` → 拿 batch_id
2. `lma_import_confirm {batch_id, dedupe_strategy: "skip", source_note: "WCA 2026-09 导出"}` → 61 条入库
3. `lma_match {supplier_id: 1}` → 匹配度评分
4. `lma_draft {supplier_id: 1}` → 草稿（含页脚）
5. `lma_review_queue` → `lma_review {draft_id, action: "approve"}`
6. `lma_send {draft_id}` → 入队（自动节流/工作时段/退订检查）

## 六、本地测试

```bash
pnpm vitest run --config lma-plugin/vitest.config.ts
```

覆盖：CSV 解析（真实 WCA 荷兰模板 61 条记录（多行引号字段））、字段映射、去重策略、时区推断、AI mock 匹配与草稿硬限制、发送队列（退订拦截/节流/事件落库）、IMAP 事件分类，以及 **Harness 集成**（`new Context()` + SystemPrompt + ToolRuntime 装配，`ctx.tools.execute` 跑通 导入→匹配→草稿→审核→发送→事件 全流程）。

## 七、部署（1 核 2G 生产）

- `systemd` 托管：`ExecStart=/usr/bin/pnpm dsh web --patch /opt/harness/lma-plugin/cordis.yml`（配合 `Restart=always`）
- Nginx 反代：Web UI 与 `/unsubscribe` 路径分开——`/unsubscribe` 反代到 `127.0.0.1:LMA_HTTP_PORT`（插件内置退订端点），`LMA_BASE_URL` 设为正式域名
- SQLite 每日备份（`LMA_DB_BACKUP_DIR`，备份前自动 WAL checkpoint）或 systemd timer 复制 `lma-data/lma.db`
- 邮件走真实 SMTP 前，先用 log 模式 + 测试收件箱验证流程；`LMA_ADMINS` 配置两位业务伙伴的标识
- 合规提醒：CSV 数据同样受新西兰 UEMA 2007 与 IPP 3A（2026-05-01 生效）约束，须能说清数据合法来源；正式发送前咨询当地法律顾问

## 八、二开扩展点

- **新增数据源**：写一个适配器产出 `{columns, rows}` 交给 `csvpipeline` 即可（PRD 4.2 可插拔管道）
- **换 LLM**：`LMA_AI_URL` 指向任意 OpenAI 兼容端点
- **新增工具**：在 `tools.ts` 用 `textTool()` 加一条，插件重启即注册
- **Agent 私有化定制**：Agent 有 `lma_project_knowledge` 全文知识 + 全部读写工具，可独立完成"导入→触达→跟进→复盘"闭环；未来可用 dsh `extensions` 子系统让 Agent 动态新建 Cordis 包

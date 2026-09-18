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
| `LMA_ADMINS` | 空 | **admin** 名单（逗号分隔）。全部权限：导入/导出/配置/账号与画像/审核/发送/统计 |
| `LMA_STAFF` | 空 | **staff** 名单（逗号分隔）。业务操作：查看列表/审核邮件/发送/标记跟进/导出数据 |
| `LMA_OPERATOR` | `harness-agent` | 工具未传 operator 时默认审计操作者 |
| `LMA_BASE_URL` | `http://127.0.0.1:3081` | HTTP 退订端点域名。**仅在未配置发件地址时**作为页脚兜底（默认走回信退订，见 §五）；生产可改 HTTPS 域名反代到 `LMA_HTTP_PORT` |
| `LMA_HTTP_PORT` | `3081` | 插件内置 Web 服务端口：`/` 仪表盘、`/unsubscribe` 退订端点、`/api/*` JSON API（绑 127.0.0.1，Node 原生 http，零依赖） |
| `LMA_COOKIE_SECRET` | `lma-dev-secret` | HTTP 退订 token 的 HMAC 密钥。⚠️ 默认值是开发用弱密钥，且 token 确定性、无过期机制——把 `/unsubscribe` 暴露到公网前**务必换成强随机值** |
| `LMA_AI_MODE` | `mock` | `mock` 离线规则 / `api` 对接 OpenAI 兼容接口 |
| `LMA_AI_URL` / `LMA_AI_KEY` / `LMA_AI_MODEL` | 空 / 空 / `deepseek-chat` | api 模式必填（也兼容任意 OpenAI 兼容服务） |
| `LMA_SMTP_HOST/PORT/SECURE/USER/PASS` | 空 | 填了走真实 SMTP；不填走 log 模式（只记录事件）。⚠️ 还需装 `nodemailer`，否则会**假报成功**，详见 §五 |
| `LMA_MAIL_FROM` | SMTP_USER | 发件人；同时作为**回信退订地址**（页脚 mailto + `List-Unsubscribe` 头） |
| `LMA_IMAP_ENABLED/HOST/PORT/TLS/USER/PASS` | false / 空 | `LMA_IMAP_ENABLED=true` 开启每 5 分钟轮询（回复 / 退信 / **退订关键词**）。需装 `imapflow`，关键词与判定规则见 §五 |
| `LMA_AI_URL` 未配且 `LMA_AI_KEY` 为空 | — | mock 模式，无需任何密钥即可本地跑通 |

## 五、邮件投递与退订（SMTP / IMAP）

### 5.1 两种投递模式

| 模式 | 触发条件 | 表现 |
|---|---|---|
| `log`（默认） | 未配 `LMA_SMTP_HOST/USER`，或 `nodemailer` 未安装 | 不发真邮件，只写 `email_event`；日志出现 `[lma:mail:log]` |
| `smtp` | 配了 `LMA_SMTP_HOST/USER` **且** `nodemailer` 能加载 | 真投递，事件的 `messageId` 是服务商返回的真实 ID |

判断一封是否真的发出去了，只看事件里这两个字段：

```json
{"mode":"smtp","messageId":"<xxx@gmail.com>","to":"a@b.com","subject":"..."}
```

> ⚠️ **必须装 `nodemailer`**。它是可选依赖（`try/catch` 动态 `import`），而 `mailer.ts` 的
> `smtpConfigured()` **只检查环境变量、不看依赖是否加载成功**——没装 nodemailer 时，
> 事件照样写成 `mode:"smtp"`（但 `messageId` 为 `null`），实际一封都没发出去。
> IMAP 同理需要 `imapflow`。

```bash
# 两个可选依赖都没写进 package.json，按需安装
cd lma-plugin && npm install nodemailer imapflow --no-save
```

### 5.2 Gmail 测试配置（示例）

Gmail 不接受账号登录密码，必须用**应用专用密码**：先开启两步验证，再到
<https://myaccount.google.com/apppasswords> 生成 16 位密码（显示成 4 组，空格可去掉）。

```bash
# 发信（SMTP，465 + SSL 正好是插件默认值）
LMA_SMTP_HOST=smtp.gmail.com
LMA_SMTP_PORT=465
LMA_SMTP_SECURE=true
LMA_SMTP_USER=you@gmail.com
LMA_SMTP_PASS=<16 位应用专用密码>
LMA_MAIL_FROM=you@gmail.com

# 收信轮询（IMAP：回复 / 退信 / 退订）
LMA_IMAP_ENABLED=true
LMA_IMAP_HOST=imap.gmail.com
LMA_IMAP_PORT=993
LMA_IMAP_TLS=true
LMA_IMAP_USER=you@gmail.com
LMA_IMAP_PASS=<同一个应用专用密码>
```

> ⚠️ **环境变量在模块加载时读取（`mailer.ts` / `imap.ts` 顶层 `const`），改完必须重启 `dsh web` 才生效。**
> 建议先在重启前用独立脚本验证凭据（`python3 -c "import smtplib..."` 或 `openssl s_client`），避免白重启一次。

> 容量与合规：Gmail 免费账号约 500 收件人/天，且用个人 Gmail 批量发推广邮件不符合 Google 条款、有被限制的风险。
> Gmail 仅适合本地验证链路，正式投放请换 SendGrid / Resend / 阿里云邮件推送等服务商。

### 5.3 退订：回信制（reply-to-unsubscribe）

页脚与 `List-Unsubscribe` 头**都指向"回信"**，不依赖公网可达的退订页：

```text
To unsubscribe, reply to this email with "unsubscribe" in the subject line,
or click: mailto:you@gmail.com?subject=Unsubscribe
```
```text
List-Unsubscribe: <mailto:you@gmail.com?subject=Unsubscribe>
```

收件人回复后，IMAP 轮询（每 5 分钟）按关键词判定并自动处理：

```text
classify() 命中 → 写入 unsubscribe_list(source='reply_keyword')
               → 供应商置为 unsubscribed
               → 此后所有发送被 sendqueue 硬拦
               → audit_log 记 unsubscribe_auto
```

**关键词**（`imap.ts`）：`unsubscribe` / `opt-out` / `退订` / `取消订阅` / `停止发送` / `不再接收` / `不再联系` / `配信停止` / `配信解除`。

三条判定规则（都是踩过坑才补上的）：

1. **主题优先**：`msg.envelope.subject` 由 IMAP 客户端解码，判定最可靠；页脚文案因此专门引导收件人把关键词写在**主题**里。
2. **只看新增正文**：引用历史里必然带着我方页脚的 "unsubscribe" 字样，若扫全文会把**任何带引用的普通回复误判成退订**。
   `newPortion()` 先剔除邮件头、引用行与常见分隔符，只对收件人新写的内容做匹配。
3. **中文关键词不能包进 `\b(...)\b`**：`\b` 只在 ASCII 词与非词字符之间成立，中日文字符两侧都不构成词边界，
   `\b退订\b` 在正常中文句子里**永远匹配不到**。ASCII 词用 `\b` 包裹、CJK 词裸列。

### 5.4 轮询的安全边界

`pollOnce()` 只处理「**首次外发之后**」的未读邮件（以 `email_event` 中最早的 `sent` 时间为界再往前留 2 天），
并且 **`\Seen` 只加在真正匹配到供应商的邮件上**。否则会把收件箱里所有未读邮件（个人邮件、退信、服务通知）
静默标记为已读——这是开轮询前必须确认的一条。

匹配方式：发件人邮箱命中 `supplier.email`，或 `In-Reply-To` / `References` 命中某个 `sent` 事件的 `messageId`。

### 5.5 HTTP 退订端点（兜底保留）

`GET /unsubscribe?e=<email>&t=<hmac>` 仍在（`src/unsubscribe.ts`，常数时间校验 + 幂等写入），
但只在**未配置 `LMA_MAIL_FROM` / `LMA_SMTP_USER`** 时才会出现在页脚里，作为本地/离线环境的后备路径。

### 5.6 角色与权限（PRD 三、用户角色）

判定逻辑**收敛在 `src/roles.ts` 一处**，`tools.ts`（Agent 工具）与 `web/api.ts`（仪表盘）共用：

| 角色 | 名单来源 | 权限 |
|---|---|---|
| **admin** | `LMA_ADMINS` | 全部：导入/导出数据、配置、管理账号、维护业务画像、审核、发送、看统计 |
| **staff** | `LMA_STAFF` | 业务操作：查看列表、审核邮件、发送、标记跟进、导出数据 |

按工具的落点：

| 工具 | 要求 |
|---|---|
| `lma_import_confirm`（CSV 导入） | **仅 admin** |
| `lma_config_update`（配置/画像） | **仅 admin** |
| `lma_event_record`（人工补录事件） | **仅 admin** |
| `lma_supplier_edit` / `lma_supplier_delete` | **仅 admin** |
| `lma_unsubscribe_add`（退订名单维护） | **仅 admin** |
| `lma_review`（审核）/ `lma_send`（发送）/ `lma_followup_check`（跟进） | admin 或 staff |
| `lma_export_csv`（导出） | admin 或 staff |
| 只读工具（`lma_dashboard`/`lma_suppliers`/…） | 不校验 |

注意事项：

- **不在任何名单里的操作者，写操作一律拒绝**；未显式传 `operator` 时取 `LMA_OPERATOR`（默认 `harness-agent`），**它不在任何名单里，所以有权限要求的工具必须显式传 `operator`**
- 前端隐藏按钮只是体验，**后端必须强制**（`roles.ts` 就是那道闸）
- 这是环境变量版的最小落地；接入登录后把 `roles.ts` 改成查 `lma_user` 表（已含 `username`/`password_hash`/`role`/`status`）即可，**调用方不用动**

## 六、工具清单（模型可调用）

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

## 七、本地测试

```bash
pnpm vitest run --config lma-plugin/vitest.config.ts
```

当前 **50 项全部通过**（改动退订/发信逻辑后请以此为回归基线）。覆盖：CSV 解析（真实 WCA 荷兰模板 61 条记录（多行引号字段））、字段映射、去重策略、时区推断、AI mock 匹配与草稿硬限制、页脚退订方式（mailto 与 HTTP 兜底两条分支）、退订关键词分类（中文命中 / 引用不误判 / 退信不受影响）、发送队列（退订拦截/节流/事件落库），以及 **Harness 集成**（`new Context()` + SystemPrompt + ToolRuntime 装配，`ctx.tools.execute` 跑通 导入→匹配→草稿→审核→发送→事件 全流程）。

## 八、部署（1 核 2G 生产）

- `systemd` 托管：`ExecStart=/usr/bin/pnpm dsh web --patch /opt/harness/lma-plugin/cordis.yml`（配合 `Restart=always`）
- 退订走**回信制**，无需把任何端口暴露到公网：页脚与 `List-Unsubscribe` 头都是 `mailto:`，IMAP 轮询按关键词自动退订
- 只有在必须保留 HTTP 退订端点时，才用 Nginx **只反代 `/unsubscribe` 一条路径**到 `127.0.0.1:LMA_HTTP_PORT`（**不要整端口暴露**：同端口上还有仪表盘与 `/api/*` 写接口），并把 `LMA_COOKIE_SECRET` 换成强随机值
- 上线前务必装好 `nodemailer`（发信）与 `imapflow`（收信），并在事件里确认 `mode:"smtp"` 且 `messageId` 非空
- SQLite 每日备份（`LMA_DB_BACKUP_DIR`，备份前自动 WAL checkpoint）或 systemd timer 复制 `lma-data/lma.db`
- 邮件走真实 SMTP 前，先用 log 模式 + 测试收件箱验证流程；`LMA_ADMINS` 配置两位业务伙伴的标识
- 合规提醒：CSV 数据同样受新西兰 UEMA 2007 与 IPP 3A（2026-05-01 生效）约束，须能说清数据合法来源；正式发送前咨询当地法律顾问

## 九、二开扩展点

- **新增数据源**：写一个适配器产出 `{columns, rows}` 交给 `csvpipeline` 即可（PRD 4.2 可插拔管道）
- **换 LLM**：`LMA_AI_URL` 指向任意 OpenAI 兼容端点
- **新增工具**：在 `tools.ts` 用 `textTool()` 加一条，插件重启即注册
- **Agent 私有化定制**：Agent 有 `lma_project_knowledge` 全文知识 + 全部读写工具，可独立完成"导入→触达→跟进→复盘"闭环；未来可用 dsh `extensions` 子系统让 Agent 动态新建 Cordis 包

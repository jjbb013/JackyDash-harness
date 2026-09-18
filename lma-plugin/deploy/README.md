# LMA 部署（VPS）

把**聊天 UI** 与 **LMA 仪表盘**部署到一台 VPS，供 3~5 位同事使用。

## 一、部署后长什么样

```
                      ┌──────────────────────────────────────────┐
  浏览器 ── HTTPS ──▶ │ Caddy / Nginx（80/443，自动证书）          │
                      │                                          │
                      │  /            → 127.0.0.1:3080  聊天 UI   │
                      │  /lma/        → 127.0.0.1:3081  LMA 仪表盘 │
                      └──────────────────────────────────────────┘
                                        │
                          systemd: lma.service（User=dsh）
                                        │
                     SQLite: /var/lib/dsh/lma.db（不在仓库目录里）
```

- **两个服务同域不同路径**：仪表盘挂在 `/lma/` 子路径下。仪表盘页面用的是**相对 URL**，
  所以反代必须把 `/lma/` 前缀**剥掉**再转给插件（Caddy 的 `handle_path`、Nginx `proxy_pass .../` 末尾那个斜杠）。
- `/lma` **缺尾斜杠要 301 补上**，否则页面里的 `api/xxx` 会解析到根路径、打到聊天 UI 上。
- **`/lma/unsubscribe` 绝不能加鉴权**：它是邮件里的退订链接，token 本身就是凭证，收件人必须匿名可达。
- 只有 3080/3081 在回环地址上；公网只经反代。

## 二、要求

| 项 | 要求 |
|---|---|
| 系统 | Debian 12 / Ubuntu 22.04+（脚本走 apt） |
| 内存 | ≥2GB（1GB 机器脚本会自动建 2GB swap，否则 `pnpm install` 容易被 OOM kill） |
| 磁盘 | ≥8GB（`node_modules` 约 1.5GB） |
| 域名 | 一个 A 记录指向本机（例：`jackydash.will-pan.com`） |
| 端口 | 开放 80/443；3080/3081 不要对外开 |

## 三、一键部署

```bash
# 在 VPS 上以 root 执行
curl -fsSL https://raw.githubusercontent.com/jjbb013/JackyDash-harness/master/lma-plugin/deploy/install.sh -o /tmp/lma-install.sh
LMA_DOMAIN=jackydash.will-pan.com bash /tmp/lma-install.sh
```

可选参数（都可以用环境变量覆盖）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LMA_DOMAIN` | `jackydash.will-pan.com` | 对外域名 |
| `LMA_PROXY` | `caddy` | `caddy` / `nginx` / `none` |
| `LMA_APP_DIR` | `/opt/dsh` | 代码目录 |
| `LMA_DATA_DIR` | `/var/lib/dsh` | 数据目录（数据库、备份） |
| `LMA_RUN_USER` | `dsh` | 运行用户（非 root） |

脚本做这些事（**幂等**，可重复执行）：

1. 前置检查（root / 磁盘 / 内存，必要时建 swap）
2. 装基础软件 → 装 Node 24 + pnpm
3. 建运行用户与目录（`/var/lib/dsh` 放数据库，**故意不放仓库里**）
4. clone 或 `git pull` 仓库到 `/opt/dsh`
5. `pnpm install`，再单独装 `nodemailer` / `imapflow`（`npm install` 到插件自己的 `node_modules`，
   **不改 package.json / lockfile** —— 因为仓库的 third-party-notices 守卫按其发布策略只放行固定许可证白名单，
   而 nodemailer 是 MIT-0）
6. **构建客户端插件**（`lma-plugin/lib/` 被 gitignore，全新 clone 里没有产物 —— 不构建则侧边栏「LMA 推广」入口加载失败）
7. 把 `cordis.yml` 里的绝对路径改写成本机部署路径（**写错了插件根本加载不了**）
8. 生成 `/etc/dsh/lma.env`（0600）+ 随机管理员密码 + 随机 `LMA_COOKIE_SECRET`
9. 装 systemd 服务与每日备份 timer，启动并检查
10. 配反代与 HTTPS

> 首次部署请**立刻记下脚本输出的初始管理员密码**（也写在 `/etc/dsh/lma.env`）。

## 四、装完必做的三件事

```bash
# 1) 填 SMTP / IMAP 密码（模板里是占位符），然后重启
vim /etc/dsh/lma.env          # LMA_SMTP_PASS / LMA_IMAP_PASS
systemctl restart lma

# 2) 登录仪表盘：https://<域名>/lma/   （首登强制改密）
#    然后在「人员管理」给同事建账号、在「配置」配 AI 端点和 API Key

# 3) 立刻跑一次备份，确认链路通
systemctl start lma-backup && ls -lh /var/lib/dsh/backups
```

## 五、日常运维

```bash
systemctl status lma                 # 状态
journalctl -u lma -f                 # 实时日志（首登一次性密码也在这里）
systemctl restart lma                # 改完 lma.env 必须重启才生效
journalctl -u lma -n 200 --no-pager  # 回看日志

# 备份
systemctl start lma-backup                     # 手动跑一次
systemctl list-timers lma-backup.timer         # 看下次时间
ls -lh /var/lib/dsh/backups                    # 每日快照；weekly/ 是周归档
```

### 升级

```bash
cd /opt/dsh
systemctl start lma-backup          # 先备份！
git pull
pnpm install
pnpm --filter @lma/dsh-plugin run build:client   # 改了 src/client/ 才需要
systemctl restart lma               # 冷启动 1~3 秒
```

> ⚠️ **不要跑两个实例做"零停机"**：插件内含发送队列、IMAP 轮询、跟进定时任务，
> 两个进程共用同一个库里会**重复发信**。WAL 只保证写不坏，不保证业务幂等。

### 恢复演练（建议每季度一次）

```bash
systemctl stop lma
cp /var/lib/dsh/lma.db /var/lib/dsh/lma.db.broken        # 留个现场
LATEST=$(ls -1t /var/lib/dsh/backups/lma-*.db | head -1)
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('$LATEST')
console.log('integrity:', Object.values(db.prepare('PRAGMA integrity_check').get())[0])
console.log('supplier:', db.prepare('SELECT COUNT(*) AS c FROM supplier').get().c,
            '| 最近事件:', db.prepare('SELECT MAX(event_time) AS t FROM email_event').get().t)
db.close()"
install -o dsh -g dsh -m 600 "$LATEST" /var/lib/dsh/lma.db
systemctl start lma
```

## 六、踩过的坑（部署相关）

| 坑 | 症状 | 解法 |
|---|---|---|
| `cordis.yml` 里是**绝对路径** | 插件加载不了 / 工具不存在 | install.sh 会自动改写成 `$APP_DIR/lma-plugin/src/index.ts` |
| `lma-plugin/lib/` 被 gitignore | 侧边栏没有「LMA 推广」入口 | 必须跑 `pnpm --filter @lma/dsh-plugin run build:client` |
| `/lma` 缺尾斜杠 | 页面能开但接口 404 | 301 补斜杠（Caddy `redir` / Nginx `location = /lma`） |
| 反代没剥前缀 | 页面能开但接口全 404 | Caddy 用 `handle_path`；Nginx `proxy_pass` 末尾加 `/` |
| `/unsubscribe` 被套上鉴权 | 邮件里点退订 401 | 该路径必须匿名可达 |
| Cookie 的 `Secure` | 生产下 Cookie 发不出去 / 或该有却没有 | 设 `LMA_PUBLIC_URL=https://…`（会自动开 Secure 并用 `__Host-` 前缀） |
| 审计 IP 记成 127.0.0.1 或被伪造 | 溯源不准 | 取 `X-Forwarded-For` **最右**一跳（代码已这么实现） |
| 服务器上没配 `LMA_PUBLIC_URL` | 邮件里的退订链接指向 localhost | 代码按平台判断（Linux=服务器）并在启动日志里**告警** |
| 用 `cp` 备份 SQLite | 恢复出来是旧数据 | 用 `VACUUM INTO`（`lma-backup.sh` 已实现） |
| 把 `nodemailer` 写进 `package.json` | 预提交钩子报 `nodemailer (MIT-0) is not a permissive license` 并中断提交 | 它是仓库的发布策略白名单问题；**部署时单独安装**，别动 package.json |
| shell 里 `$VAR（` 紧跟全角字符 | `VAR?: unbound variable`（bash 把多字节并入变量名） | 写成 `${VAR}` |
| 蓝绿双实例 | 重复发信 | 单实例 + `systemctl restart` |

## 七、安全清单

- [ ] `/etc/dsh/lma.env` 权限 `0600 root:root`；数据库 `0600`
- [ ] `LMA_COOKIE_SECRET` 是随机值（HTTP 退订 token 的签名密钥，默认值等于没有防护）
- [ ] 首登后立刻改掉初始管理员密码
- [ ] 只在「人员管理」里建账号（无自助注册）
- [ ] 「聊天 UI 能做什么」由 `harness-agent` 这个服务账号的角色决定；不需要聊天端管理能力就把它降为 staff
- [ ] 备份做了异地（`LMA_BACKUP_RCLONE`）且库含个人信息，异地前建议先加密
- [ ] Gmail 只能用应用专用密码，且正式投放建议换 SendGrid / Resend 等服务商（个人 Gmail 发推广邮件不符合其条款）

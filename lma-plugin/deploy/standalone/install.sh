#!/usr/bin/env bash
# LMA 独立版安装脚本（Debian 12 / Ubuntu 22.04+，≥2GB 内存）
#
# 用法：
#   sudo LMA_DOMAIN=lma.example.com bash install.sh
#
# 产物：
#   /opt/lma/lma-plugin/    应用代码（standalone 分支）
#   /etc/lma/lma.env        环境变量（0600）
#   /var/lib/lma/           数据（SQLite + 备份）
#   systemd 单元 lma.service
#   本地监听 127.0.0.1:3081，由 Caddy/Nginx 反代到 80/443
#
# 幂等：已存在的 lma.env 不覆盖，数据库不删。
set -euo pipefail

DOMAIN="${LMA_DOMAIN:-}"
REPO_URL="${LMA_REPO_URL:-https://github.com/jjbb013/JackyDash-harness.git}"
BRANCH="${LMA_BRANCH:-standalone}"
APP_DIR="${LMA_APP_DIR:-/opt/lma}"
DATA_DIR="${LMA_DATA_DIR:-/var/lib/lma}"
ETC_DIR="${LMA_ETC_DIR:-/etc/lma}"
RUN_USER="${LMA_RUN_USER:-lma}"
HTTP_PORT="${LMA_HTTP_PORT:-3081}"

say() { echo -e "\033[1;36lma-install\033[0m $*"; }
ok()  { echo -e "  \033[32m✓\033[0m $*"; }
die() { echo -e "  \033[31m✗ $*\033[0m" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "必须设置域名：sudo LMA_DOMAIN=mail.your-domain.com bash install.sh"
[ "$(id -u)" -eq 0 ] || die "请用 root/sudo 运行"

# ---------- 1. 系统用户与目录 ----------
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  ok "创建系统用户 $RUN_USER"
fi
mkdir -p "$APP_DIR" "$DATA_DIR" "$ETC_DIR"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 750 "$ETC_DIR"

# ---------- 2. Node 22 ----------
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  ok "已装 Node $(node -v)"
else
  say "安装 Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v)"
fi

# ---------- 3. 拉代码 ----------
say "拉取 $REPO_URL @ $BRANCH → $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
ok "代码就绪"

# ---------- 4. 依赖 ----------
say "安装依赖（应用本身零运行时依赖；可选邮件库 nodemailer/imapflow）"
cd "$APP_DIR/lma-plugin"
sudo -u "$RUN_USER" npm install --omit=dev >/dev/null 2>&1 || true
# 邮件收发库（MIT-0 许可，仓库白名单不收，--no-save 装在本地）
sudo -u "$RUN_USER" npm install --no-save nodemailer imapflow >/dev/null 2>&1 || \
  warn "nodemailer/imapflow 未装上：发信/收信暂不可用，稍后可手动 npm i --no-save"
ok "依赖就绪"

# ---------- 5. 环境变量 ----------
ENV_FILE="$ETC_DIR/lma.env"
if [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE 已存在，保留不动"
else
  COOKIE_SECRET="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40)"
  ADMIN_PASS="$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"
  cat > "$ENV_FILE" <<EOF
# LMA 独立版配置（安装于 $(date -Iseconds)）
LMA_HTTP_PORT=$HTTP_PORT
LMA_DB_PATH=$DATA_DIR/lma.db
LMA_DB_BACKUP_DIR=$DATA_DIR/backups
LMA_PUBLIC_URL=https://$DOMAIN
LMA_COOKIE_SECURE=1
LMA_COOKIE_SECRET=$COOKIE_SECRET

# 初始管理员（首次登录强制改密）
LMA_ADMIN_USER=admin
LMA_ADMIN_PASSWORD=$ADMIN_PASS

# AI 助手：mock 起步，配好后在仪表盘「配置」里改 api 模式
LMA_AI_MODE=mock

# SMTP / IMAP（在仪表盘「配置」里填，或取消注释在此设置）
# LMA_SMTP_HOST=
# LMA_SMTP_PORT=465
# LMA_SMTP_USER=
# LMA_SMTP_PASS=
# LMA_MAIL_FROM=
# LMA_IMAP_HOST=
# LMA_IMAP_USER=
# LMA_IMAP_PASS=
EOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  ok "已生成 $ENV_FILE"
  echo ""
  echo -e "  \033[1;33m初始管理员：admin / $ADMIN_PASS\033[0m"
  echo -e "  （保存在 $ENV_FILE；首次登录会强制改密）"
  echo ""
fi

# ---------- 6. systemd ----------
say "安装 systemd 单元"
cp "$APP_DIR/lma-plugin/deploy/standalone/lma.service" /etc/systemd/system/lma.service
systemctl daemon-reload
systemctl enable lma >/dev/null 2>&1
systemctl restart lma
sleep 2
systemctl --no-pager --full status lma | head -5 || true

# ---------- 7. 反代提示 ----------
cat <<EOF

════════════════════════════════════════════════════════════
 LMA 独立版已装。下一步：
  1) DNS 把 $DOMAIN 指向本机
  2) 反代把 443 → 127.0.0.1:$HTTP_PORT
     （参考 lma-plugin/deploy/Caddyfile 或 nginx.conf，把 backend 端口改成 $HTTP_PORT）
  3) 浏览器开 https://$DOMAIN 登录
  4) 在「配置」里填 SMTP/IMAP 与 AI 端点
  日志：journalctl -u lma -f
════════════════════════════════════════════════════════════
EOF

#!/usr/bin/env bash
# LMA SQLite 一致性备份（VACUUM INTO + integrity_check + 保留策略 + 可选异地）
#
# 为什么不用 cp：WAL 模式下最新提交可能只在 -wal 文件里，单独拷 .db 会得到旧快照；
# 把 .db/-wal/-shm 逐个拷贝也不是原子的（三次拷贝之间仍可能有提交）。
# VACUUM INTO 由 SQLite 自己生成**在线一致快照**，且不阻塞读。
#
# 用法：sudo -u dsh /opt/dsh/lma-plugin/deploy/lma-backup.sh
# 定时：由 lma-backup.timer 每天调用
set -Eeuo pipefail

DB="${LMA_DB_PATH:-/var/lib/dsh/lma.db}"
DEST="${LMA_BACKUP_DIR:-/var/lib/dsh/backups}"
KEEP_DAYS="${LMA_BACKUP_KEEP_DAYS:-7}"
KEEP_WEEKS="${LMA_BACKUP_KEEP_WEEKS:-4}"
RCLONE_REMOTE="${LMA_BACKUP_RCLONE:-}"
NODE_BIN="${LMA_NODE_BIN:-node}"

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "❌ $*"; exit 1; }

[ -f "$DB" ] || die "数据库不存在：${DB}（检查 LMA_DB_PATH）"
command -v "$NODE_BIN" >/dev/null || die "找不到 node（可用 LMA_NODE_BIN 指定绝对路径）"
mkdir -p "$DEST"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/lma-$STAMP.db"
[ -e "$OUT" ] && die "目标已存在：$OUT"

# ---------- 1) 一致快照 ----------
log "生成快照 → $OUT"
SRC="$DB" OUT="$OUT" "$NODE_BIN" --input-type=module -e '
import { DatabaseSync } from "node:sqlite"
const src = process.env.SRC, out = process.env.OUT
const db = new DatabaseSync(src)
// SQLite 的字符串字面量用单引号；路径里的单引号按 SQL 规则转义
db.exec("VACUUM INTO \x27" + out.replace(/\x27/g, "\x27\x27") + "\x27")
db.close()
' || die "VACUUM INTO 失败"

# ---------- 2) 完整性校验（备份不可用等于没备份）----------
log "校验快照"
SRC="$OUT" "$NODE_BIN" --input-type=module -e '
import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(process.env.SRC)
const row = db.prepare("PRAGMA integrity_check").get()
const val = row ? String(Object.values(row)[0]) : "no-result"
db.close()
if (val !== "ok") { console.error("integrity_check 未通过：" + val); process.exit(1) }
' || die "快照校验失败，已保留现场：$OUT"

# ---------- 3) 指纹（异地存放时便于比对）----------
if command -v sha256sum >/dev/null; then
  sha256sum "$OUT" > "$OUT.sha256"
  log "sha256: $(cut -d' ' -f1 "$OUT.sha256")"
fi
log "✅ 备份完成：${OUT}（$(du -h "$OUT" | cut -f1)）"

# ---------- 4) 保留策略：每日 N 天 + 每周 M 份 ----------
DELETED=$(find "$DEST" -maxdepth 1 -type f -name 'lma-*.db' -mtime "+$KEEP_DAYS" -print -delete | wc -l)
log "清理超过 ${KEEP_DAYS} 天的每日备份：${DELETED} 个"

if [ "$(date +%u)" = "7" ]; then
  mkdir -p "$DEST/weekly"
  WEEKLY="$DEST/weekly/lma-$(date +%G-W%V).db"
  [ -e "$WEEKLY" ] || cp -p "$OUT" "$WEEKLY"
  ls -1t "$DEST"/weekly/lma-*.db 2>/dev/null | tail -n "+$((KEEP_WEEKS + 1))" | xargs -r rm -f
  log "已保留本周归档：${WEEKLY}（最多保留 ${KEEP_WEEKS} 份周备份）"
fi

# ---------- 5) 可选：加密 + 异地 ----------
# 数据库含邮箱与退订名单（个人信息），异地存放前建议先加密：
#   age -r <公钥> "$OUT" > "$OUT.age" && rm -f "$OUT"
if [ -n "$RCLONE_REMOTE" ]; then
  command -v rclone >/dev/null || die "配了 LMA_BACKUP_RCLONE 但找不到 rclone"
  log "同步到异地：$RCLONE_REMOTE"
  rclone copy "$DEST" "$RCLONE_REMOTE" --include 'lma-*' --quiet || die "rclone 同步失败"
  log "✅ 异地同步完成"
else
  log "提示：未配置 LMA_BACKUP_RCLONE，备份只在本地 —— 建议按 deploy/README.md 做异地与恢复演练"
fi

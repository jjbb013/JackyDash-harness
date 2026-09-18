#!/usr/bin/env python3
"""把 deploy/Caddyfile 里的 LMA 站点块（含登录页 / forward_auth / 仪表盘）拼进现有 Caddyfile。

适用场景：服务器上已经有可用的 Caddyfile（典型是已经用 Google Trust Services 的
ACME + EAB 签了证书），**不能整文件覆盖**，否则会丢证书配置。

做法：保留现有 Caddyfile 直到站点块里 `tls { … }` 的闭合大括号，之后整段换成
deploy/Caddyfile 里站点块的内容。可重复执行（每次都会先备份）。

用法（在仓库根目录）：
    sudo python3 lma-plugin/deploy/patch-caddy-lma.py
    sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    sudo systemctl reload caddy
"""
import os
import shutil
import sys
import time

SRC = "/etc/caddy/Caddyfile"
TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Caddyfile")


def site_block_body(path):
    """取出站点块的块体：第一行形如 `<域名> {`，最后一行是收尾的 `}`。"""
    with open(path, encoding="utf-8") as fh:
        lines = [line for line in fh if not line.lstrip().startswith("#")]
    start = next(i for i, line in enumerate(lines) if line.rstrip().endswith("{"))
    end = next(i for i in range(len(lines) - 1, start, -1) if lines[i].strip() == "}")
    return "".join(lines[start + 1 : end])


def main():
    if not os.path.exists(SRC):
        sys.exit("找不到 " + SRC + "：全新部署请直接用 deploy/Caddyfile")
    body = site_block_body(TEMPLATE)
    if "forward_auth" not in body:
        sys.exit("模板里没有 forward_auth，deploy/Caddyfile 结构可能已被改动")

    shutil.copy2(SRC, "{}.bak-{}".format(SRC, time.strftime("%Y%m%d-%H%M%S")))
    with open(SRC, encoding="utf-8") as fh:
        lines = fh.readlines()

    start = next(i for i, line in enumerate(lines) if line.strip() == "tls {")
    end = None
    depth = 0
    for i in range(start, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        if depth == 0:
            end = i
            break
    if end is None:
        sys.exit("找不到 tls 块的闭合大括号")

    with open(SRC, "w", encoding="utf-8") as fh:
        fh.write("".join(lines[: end + 1]))
        fh.write("\n")
        fh.write(body)
        fh.write("}\n")
    print("保留前 {} 行（含 tls 块），之后替换为模板站点块（{} 行）".format(end + 1, body.count("\n") + 1))


if __name__ == "__main__":
    main()

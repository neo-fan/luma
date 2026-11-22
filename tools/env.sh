#!/usr/bin/env bash
# 统一用系统 Node（v24），屏蔽 WorkBuddy 工具 shell 自带的 node 22。
#
# 用法（每条命令前一行）：
#   source tools/env.sh && corepack pnpm test
#
# 为什么需要它：工具 shell 的 PATH 里 `~/.workbuddy/binaries/node/…` 排在前面，
# `node -v` 会得到 22；而项目与 CI 都以 24 为准（workflows 里 node-version: "24"）。
# 在 22 上跑构建不会报错，但等于用另一个运行时验证 24 的产物，属于假验证。
#
# 注意：系统目录**可能已经在 PATH 里但排在后面**，所以不能「存在就跳过」，
# 必须摘掉原有条目再插到最前，否则 node 仍解析到 22（踩过）。

SYSTEM_NODE_DIR="/c/Program Files/nodejs"

if [ -d "$SYSTEM_NODE_DIR" ]; then
  IFS=':' read -r -a _parts <<< "$PATH"
  _kept=()
  for _p in "${_parts[@]}"; do
    [ "$_p" = "$SYSTEM_NODE_DIR" ] || _kept+=("$_p")
  done
  PATH="$SYSTEM_NODE_DIR:$(IFS=:; echo "${_kept[*]}")"
  export PATH
  unset _parts _kept _p
  # bash 会缓存命令路径，切 PATH 后必须清掉，否则 `node` 仍指向旧位置
  hash -r 2>/dev/null || true
fi

if command -v node >/dev/null 2>&1; then
  echo "node $(node -v) · npm $(npm -v) · pnpm $(pnpm -v 2>/dev/null || echo '—')"
else
  echo "未找到 node，检查 $SYSTEM_NODE_DIR" >&2
  return 1 2>/dev/null || exit 1
fi

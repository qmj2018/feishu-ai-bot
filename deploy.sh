#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 20+。请先在 Linux Devbox 安装 Node.js，再执行此脚本。" >&2
  exit 1
fi
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("当前 Node.js " + process.versions.node + "，需要 20+"); process.exit(1); }'; then
  echo "Node.js 环境检查失败。请安装或切换到 Node.js 20+，并检查 PATH。" >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/bin/devbox-codex-bot.mjs" deploy "$@"

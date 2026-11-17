#!/usr/bin/env bash
set -euo pipefail
deploy_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$deploy_script_dir/scripts/bootstrap-system.sh"
ai_bot_bootstrap_system
bash "$deploy_script_dir/scripts/ensure-dependencies.sh"
npm --prefix "$deploy_script_dir" run build
exec node "$deploy_script_dir/dist/bin/feishu-ai-bot.js" deploy --skip-install "$@"

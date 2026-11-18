#!/usr/bin/env bash
# Sourced by deploy.sh so newly installed user-local tools remain on PATH.
ai_bot_node_ok() {
  command -v node >/dev/null 2>&1 && node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(process.platform === "linux" && (major > 22 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)))) ? 0 : 1)' >/dev/null 2>&1
}
ai_bot_npm_ok() {
  local candidate
  candidate="$(command -v npm 2>/dev/null)" || return 1
  case "$candidate" in /mnt/[a-zA-Z]/*|*.exe|*.cmd) return 1 ;; esac
  command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1
}
ai_bot_download() {
  if command -v curl >/dev/null 2>&1; then curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 300 "$1" --output "$2";
  else wget --quiet --timeout=30 --tries=3 "$1" --output-document="$2"; fi
}
ai_bot_os_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "当前自动补齐系统工具支持 Debian/Ubuntu（含 WSL）。请先安装：$*" >&2; return 1
  fi
  local -a privilege=()
  if [[ "$(id -u)" != 0 ]]; then
    command -v sudo >/dev/null 2>&1 || { echo "安装 $* 需要 sudo，请联系本机管理员。" >&2; return 1; }
    privilege=(sudo)
  fi
  "${privilege[@]}" apt-get update
  "${privilege[@]}" apt-get install --yes "$@"
}
ai_bot_install_node() (
  set -euo pipefail
  local architecture archive checksum filename release directory temporary
  case "$(uname -m)" in x86_64) architecture=x64 ;; aarch64|arm64) architecture=arm64 ;; *) echo '不支持当前 CPU 的 Node.js 自动安装。' >&2; return 1 ;; esac
  directory="$HOME/.local/share/feishu-ai-bot/node"
  mkdir -p "$directory"
  temporary="$(mktemp -d "$directory/.download.XXXXXXXX")"
  trap 'rm -rf -- "$temporary"' EXIT
  ai_bot_download https://nodejs.org/dist/v22.22.2/SHASUMS256.txt "$temporary/SHASUMS256.txt"
  checksum='' filename=''
  while read -r checksum_candidate filename_candidate; do
    case "$filename_candidate" in node-v22.22.2-linux-"$architecture".tar.xz) checksum="$checksum_candidate"; filename="$filename_candidate"; break ;; esac
  done < "$temporary/SHASUMS256.txt"
  [[ "$checksum" =~ ^[a-f0-9]{64}$ && "$filename" =~ ^node-v22\.22\.2-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'Node.js 官方校验清单无效。' >&2; return 1; }
  ai_bot_download "https://nodejs.org/dist/v22.22.2/$filename" "$temporary/$filename"
  (cd "$temporary" && printf '%s  %s\n' "$checksum" "$filename" | sha256sum --check --status)
  tar -xJf "$temporary/$filename" -C "$temporary"
  release="${filename%.tar.xz}"
  "$temporary/$release/bin/node" -e 'if(process.platform!=="linux" || process.versions.node!=="22.22.2")process.exit(1)'
  if [[ ! -d "$directory/$release" ]]; then mv -- "$temporary/$release" "$directory/$release"; fi
  ln -s "$directory/$release" "$temporary/current"
  mv -Tf -- "$temporary/current" "$directory/current"
  echo "Node.js 与 npm 已安装到用户目录：$directory/$release"
)
ai_bot_install_npm() (
  set -euo pipefail
  local directory temporary
  directory="$HOME/.local/share/feishu-ai-bot/npm"
  mkdir -p "$directory"
  temporary="$(mktemp -d "$directory/.download.XXXXXXXX")"
  trap 'rm -rf -- "$temporary"' EXIT
  ai_bot_download https://registry.npmjs.org/npm/10.9.4 "$temporary/metadata.json"
  ai_bot_download https://registry.npmjs.org/npm/-/npm-10.9.4.tgz "$temporary/npm.tgz"
  node - "$temporary" <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto');
const root = process.argv[2], metadata = JSON.parse(fs.readFileSync(root + '/metadata.json', 'utf8'));
const actual = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(root + '/npm.tgz')).digest('base64');
if (metadata.version !== '10.9.4' || metadata.dist?.integrity !== actual) throw new Error('npm 官方包完整性校验失败');
NODE
  tar -xzf "$temporary/npm.tgz" -C "$temporary"
  mkdir -p "$directory/bin"
  if [[ ! -d "$directory/10.9.4" ]]; then mv -- "$temporary/package" "$directory/10.9.4"; fi
  ln -sfn ../10.9.4/bin/npm-cli.js "$directory/bin/npm"
  ln -sfn ../10.9.4/bin/npx-cli.js "$directory/bin/npx"
  echo '已补齐 npm，继续使用现有 Node.js。'
)
ai_bot_bootstrap_system() {
  [[ "$(uname -s)" == Linux ]] || { echo '此一键入口支持 Linux / Windows WSL Linux。' >&2; return 1; }
  local -a missing=()
  local need_node=false need_npm=false
  # Prefer the new namespace; reuse an older installation without moving the
  # executable paths that existing services may still reference.
  local namespace
  for namespace in feishu-ai-bot devbox-codex-bot; do
    if ! ai_bot_node_ok && [[ -x "$HOME/.local/share/$namespace/node/current/bin/node" ]]; then
      export PATH="$HOME/.local/share/$namespace/node/current/bin:$PATH"
    fi
    if ! ai_bot_npm_ok && [[ -x "$HOME/.local/share/$namespace/npm/bin/npm" ]]; then
      export PATH="$HOME/.local/share/$namespace/npm/bin:$PATH"
    fi
  done
  ai_bot_node_ok || need_node=true
  ai_bot_npm_ok || need_npm=true
  if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then missing+=(git); fi
  if [[ "$need_node" == true || "$need_npm" == true ]]; then
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then missing+=(curl ca-certificates); fi
    command -v tar >/dev/null 2>&1 || missing+=(tar)
    if [[ "$need_node" == true ]]; then
      command -v xz >/dev/null 2>&1 || missing+=(xz-utils)
      command -v sha256sum >/dev/null 2>&1 || missing+=(coreutils)
    fi
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then ai_bot_os_packages "${missing[@]}"; fi
  if [[ "$need_node" == true ]]; then
    ai_bot_install_node
    export PATH="$HOME/.local/share/feishu-ai-bot/node/current/bin:$PATH"
  elif [[ "$need_npm" == true ]]; then
    ai_bot_install_npm
    export PATH="$HOME/.local/share/feishu-ai-bot/npm/bin:$PATH"
  fi
  ai_bot_node_ok && ai_bot_npm_ok || { echo 'Node.js/npm 检查未通过，部署中止。' >&2; return 1; }
  echo "OK  Node.js $(node --version)、npm $(npm --version)、$(git --version)；可用依赖均已复用。"
}

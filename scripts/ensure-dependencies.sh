#!/usr/bin/env bash
set -euo pipefail
dependency_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dependencies_match() {
  node - "$dependency_root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const matches = (list, value) => !list || (!list.includes('!' + value) && (!list.some(x => !x.startsWith('!')) || list.includes(value)));
try {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const kind of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[kind] || {})) {
      if (lock.packages[''][kind]?.[name] !== version) process.exit(1);
    }
  }
  const libc = process.report?.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  for (const [name, expected] of Object.entries(lock.packages)) {
    if (!name || !matches(expected.os, process.platform) || !matches(expected.cpu, process.arch) || !matches(expected.libc, libc)) continue;
    const actual = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
    if (actual.version !== expected.version) process.exit(1);
  }
  for (const file of ['node_modules/typescript/bin/tsc', 'node_modules/.bin/codex-acp']) {
    if (!fs.existsSync(path.join(root, file))) process.exit(1);
  }
} catch { process.exit(1); }
NODE
}
if dependencies_match; then
  echo 'OK  npm 依赖与 lockfile 一致，复用现有安装。'
elif [[ "${1:-}" == --check ]]; then
  echo '缺少 npm 依赖，或已安装版本与 lockfile 不一致。' >&2
  exit 1
else
  echo '安装缺失或版本不匹配的项目依赖。'
  npm --prefix "$dependency_root" ci --include=dev --registry=https://registry.npmjs.org/
  dependencies_match || { echo '依赖安装后校验失败。' >&2; exit 1; }
fi

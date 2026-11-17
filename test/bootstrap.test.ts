import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PROJECT_ROOT } from '../src/paths.js';

test('sufficient Linux tools skip every installer and retain the existing Node executable', { skip: process.platform !== 'linux' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, 'unexpected-install');
  for (const name of ['apt-get', 'sudo', 'curl', 'wget']) fs.writeFileSync(path.join(root, name), `#!/bin/sh\nprintf invoked >> '${trace}'\nexit 99\n`, { mode: 0o700 });
  const result = spawnSync('bash', ['-c', 'source "$1"; original=$(command -v node); ai_bot_bootstrap_system; test "$original" = "$(command -v node)"', 'bootstrap', path.join(PROJECT_ROOT, 'scripts/bootstrap-system.sh')], {
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(trace), false);
});
test('project dependency checks do not call npm when the lockfile is already satisfied', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'npm'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const result = spawnSync('bash', [path.join(PROJECT_ROOT, 'scripts/ensure-dependencies.sh'), '--check'], {
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /复用现有安装/);
});

test('missing npm is installed independently while an existing Node is reused', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync('bash', ['-c', 'source "$1"; ready=false; ai_bot_node_ok() { return 0; }; ai_bot_npm_ok() { "$ready"; }; ai_bot_install_node() { exit 99; }; ai_bot_install_npm() { ready=true; echo NPM_INSTALLED; }; ai_bot_bootstrap_system; ai_bot_bootstrap_system', 'bootstrap', path.join(PROJECT_ROOT, 'scripts/bootstrap-system.sh')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.match(/NPM_INSTALLED/g).length, 1);
});

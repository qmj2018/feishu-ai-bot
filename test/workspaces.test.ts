import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { prepareWorkspace, validateRepository } from '../src/workspaces.js';
import { run } from '../src/core.js';

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-workspaces-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const remote = 'https://git.example/team/project.git';
function source(t) {
  const root = temp(t), repo = path.join(root, 'source');
  run('git', ['init', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'readme.txt'), 'base');
  run('git', ['-C', repo, 'add', '.']);
  run('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init']);
  run('git', ['-C', repo, 'branch', 'feature']);
  const commandRunner = (command, args, options) => {
    if (!args.includes('clone')) return run(command, args, options);
    const localArgs = args.map(value => value === remote ? repo : value);
    const result = run(command, localArgs, options);
    run('git', ['-C', args.at(-1), 'remote', 'set-url', 'origin', remote]);
    return result;
  };
  return { root, repo, commandRunner };
}
test('repository input supports SSH/HTTPS but rejects credentials and executable protocols', () => {
  for (const value of [remote, 'git@git.example:team/project.git', 'ssh://git@git.example:2222/team/project.git']) assert.equal(validateRepository(value), value);
  for (const value of ['-x', 'file:///tmp/project', '/tmp/project', 'ext::sh -c bad', 'https://token@git.example/project', 'https://u:p@git.example/project', 'https://git.example/project?token=x', 'ssh://git:p@git.example/project', 'git@git.example:team/repo\n']) assert.throws(() => validateRepository(value));
});
test('workspace clones selected branch and preserves local changes when reused', t => {
  const { root, commandRunner } = source(t);
  const options = { name: 'project', repo: remote, branch: 'feature', workspaceRoot: path.join(root, 'spaces'), commandRunner };
  const created = prepareWorkspace(options);
  assert.equal(created.created, true);
  assert.equal(created.branch, 'feature');
  assert.equal(fs.readFileSync(path.join(created.project, 'readme.txt'), 'utf8'), 'base');
  assert.equal(fs.statSync(path.join(created.root, 'workspace.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(created.project, 'readme.txt'), 'local modifications');
  const reused = prepareWorkspace(options);
  assert.equal(reused.created, false);
  assert.equal(fs.readFileSync(path.join(created.project, 'readme.txt'), 'utf8'), 'local modifications');
  assert.throws(() => prepareWorkspace({ ...options, repo: 'https://git.example/other.git' }), /配置不同/);
  assert.throws(() => prepareWorkspace({ ...options, branch: 'main' }), /配置不同/);
  run('git', ['-C', created.project, 'remote', 'set-url', 'origin', 'https://git.example/changed.git']);
  assert.throws(() => prepareWorkspace(options), /origin/);
});
test('empty workspace has a committed HEAD and can create per-session worktrees', t => {
  const root = temp(t);
  const result = prepareWorkspace({ name: 'scratch', empty: true, workspaceRoot: root });
  assert.equal(result.branch, 'main');
  run('git', ['-C', result.project, 'worktree', 'add', '--detach', path.join(root, 'session'), 'HEAD']);
  assert.equal(prepareWorkspace({ name: 'scratch', workspaceRoot: root }).created, false);
  assert.equal(prepareWorkspace({ name: 'scratch', branch: 'main', workspaceRoot: root }).created, false);
});
test('failed clone cleans only its staging directory and preserves unrelated data', t => {
  const root = temp(t), unrelated = path.join(root, 'keep.txt');
  fs.writeFileSync(unrelated, 'keep');
  assert.throws(() => prepareWorkspace({ name: 'failed', repo: remote, workspaceRoot: root, commandRunner() { throw new Error('authentication failed'); } }), /创建工作空间失败/);
  assert.deepEqual(fs.readdirSync(root), ['keep.txt']);
});
test('workspace creation rejects traversal, unmanaged existing directories and symlinks', t => {
  const root = temp(t);
  assert.throws(() => prepareWorkspace({ name: '../escape', empty: true, workspaceRoot: root }));
  fs.mkdirSync(path.join(root, 'existing'));
  fs.writeFileSync(path.join(root, 'existing', 'keep'), 'keep');
  assert.throws(() => prepareWorkspace({ name: 'existing', empty: true, workspaceRoot: root }), /不是本工具管理/);
  fs.symlinkSync(path.join(root, 'existing'), path.join(root, 'linked'));
  assert.throws(() => prepareWorkspace({ name: 'linked', empty: true, workspaceRoot: root }), /普通目录/);
});
test('workspace CLI can initialize an empty workspace without npm SDK installation', t => {
  const root = temp(t);
  const result = spawnSync(process.execPath, [new URL('../bin/feishu-ai-bot.js', import.meta.url).pathname, 'workspace', 'create', '--name', 'scratch', '--empty', '--workspace-root', path.join(root, 'spaces'), '--json'], { env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).created, true);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/feishu-ai-bot.js', import.meta.url));
const runtime = fileURLToPath(new URL('../bin/feishu-runtime.js', import.meta.url));
function fixture(t, managed = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-startup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'), project = path.join(home, 'project with spaces');
  const root = path.join(home, '.feishu-runtime/bots/123e4567-e89b-42d3-a456-426614174000');
  for (const dir of [bin, project, root]) fs.mkdirSync(dir, { recursive: true });
  const metadata = { slug: 'test-bot', runtimeId: path.basename(root), workspaceMode: 'per-session-worktree' };
  const config = { project: { path: '/previous/project', name: 'Test' }, agents: { codexMode: 'read-only' },
    feishu: { appId: 'cli_test', appSecret: 'test-secret', allowedUsers: ['ou_owner'] } };
  for (const [name, value] of Object.entries({ 'runtime.json': metadata, 'feishu-runtime.json': config,
    'sessions.json': { sessions: { old: { cwd: '/old/worktree', engineSessions: { codex: 'old-thread' } } }, seen: { oldMessage: 123 } } })) {
    fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  }
  const trace = path.join(home, 'trace.jsonl');
  for (const tool of ['systemctl', 'feishu-runtime']) fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}
const fs=require('node:fs'), cp=require('node:child_process');
const args=process.argv.slice(2), tool=${JSON.stringify(tool)};
fs.appendFileSync(process.env.TRACE,JSON.stringify({tool,args})+'\\n');
if(tool==='systemctl') {
  if(args.includes('show')) console.log(${JSON.stringify(managed ? 'loaded' : 'not-found')});
} else if(args[1]==='start') {
  console.log('STARTED');
} else {
  const r=cp.spawnSync(process.execPath,[${JSON.stringify(runtime)},...args],{stdio:'inherit'});process.exit(r.status||0);
}
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH, TRACE: trace };
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, '--slug', 'test-bot'], { env, encoding: 'utf8', timeout: 10000 });
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const calls = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { project, root, invoke, read, calls };
}

for (const command of ['start', 'run', 'restart']) test(`${command} --cwd persists a non-Git directory and archives old session bindings`, t => {
  const f = fixture(t);
  const result = f.invoke(command, '--cwd', f.project, '--codex-mode', 'agent-full-access');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /STARTED/);
  assert.equal(f.read('feishu-runtime.json').project.path, f.project);
  assert.equal(f.read('feishu-runtime.json').agents.codexMode, 'agent-full-access');
  assert.equal(f.read('runtime.json').workspaceMode, 'project-directory');
  assert.deepEqual(f.read('sessions.json'), { sessions: {}, seen: { oldMessage: 123 } });
  const backups = fs.readdirSync(path.join(f.root, 'backups'));
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'backups', backups[0], 'sessions.json'), 'utf8'));
  assert.equal(saved.sessions.old.engineSessions.codex, 'old-thread');
  assert.equal(fs.existsSync(path.join(f.project, '.git')), false);
  const start = f.calls().find(call => call.tool === 'feishu-runtime' && call.args[1] === 'start');
  assert.equal(start.args.includes('--foreground'), command === 'run');
});

test('managed restart stops systemd before updating configuration, then starts the unit', t => {
  const f = fixture(t, true);
  const result = f.invoke('restart', '--project', f.project, '--workspace-mode', 'project-directory');
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const stop = calls.findIndex(c => c.tool === 'systemctl' && c.args[1] === 'stop');
  const replace = calls.findIndex(c => c.tool === 'feishu-runtime' && c.args[1] === 'config');
  const start = calls.findIndex(c => c.tool === 'systemctl' && c.args[1] === 'start');
  assert.ok(stop >= 0 && replace > stop && start > replace);
  assert.ok(!calls.some(c => c.tool === 'feishu-runtime' && c.args[1] === 'start'));
});

test('invalid startup options fail before stopping the existing service or modifying configuration', t => {
  const f = fixture(t, true), original = f.read('feishu-runtime.json');
  for (const args of [['--cwd', '/missing/bot-project'], ['--cwd', f.project, '--project', f.project],
    ['--cwd', f.project, '--workspace-mode', 'per-session-worktree'], ['--cwd', f.project, '--codex-mode', 'typo']]) {
    const result = f.invoke('restart', ...args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.read('feishu-runtime.json'), original);
  }
  assert.ok(!f.calls().some(c => c.args.includes('stop') || c.args.includes('start') || c.args.includes('replace')));
});

test('restarting with the same directory retains session IDs and selected permissions', t => {
  const f = fixture(t);
  assert.equal(f.invoke('start', '--cwd', f.project).status, 0);
  const state = { sessions: { chat: { cwd: f.project, codexMode: 'agent-full-access', engineSessions: { codex: 'resume-me' } } }, seen: { message: 123 } };
  fs.writeFileSync(path.join(f.root, 'sessions.json'), JSON.stringify(state));
  const result = f.invoke('restart', '--cwd', f.project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.read('sessions.json'), state);
});

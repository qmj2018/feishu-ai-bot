#!/usr/bin/env node
import type { BotMetadata, RuntimeConfig, RuntimePaths } from "../src/types.js";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCredentials, getDataRoot, runtimePaths, validateSlug } from '../src/core.js';
import { saveJson, updateJson } from '../src/storage.js';
import { ensureLocalCodex } from '../src/local-codex.js';
import { readServiceEnvironment, resolveServiceEnvironment } from '../src/runtime-env.js';

const root = getDataRoot();
const botsDir = path.join(root, 'bots');
const args = process.argv.slice(2);
const json = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const read = <T = RuntimeConfig>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8'));
function bots(): BotMetadata[] {
  if (!fs.existsSync(botsDir)) return [];
  return fs.readdirSync(botsDir).flatMap(id => {
    const file = path.join(botsDir, id, 'runtime.json');
    return fs.existsSync(file) ? [read<BotMetadata>(file)] : [];
  });
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function status(paths: RuntimePaths) {
  const file = path.join(paths.root, 'process.json');
  const state = fs.existsSync(file) ? read<{ pid?: number; ready?: boolean }>(file) : {};
  return { status: state.pid && alive(state.pid) ? (state.ready ? 'running' : 'starting') : 'stopped', pid: state.pid, nobind: false };
}
async function stop(paths: RuntimePaths) {
  const current = status(paths);
  if (current.status === 'stopped') return;
  process.kill(current.pid!, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    if (!alive(current.pid!)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('停止超时，请检查进程');
}
async function main() {
  const [scope, action, slug] = args;
  if (scope !== 'bots') throw new Error('用法: feishu-runtime bots list|add|setup|config|start|stop|restart|status|doctor');
  if (action === 'list') return json({ bots: bots() });
  if (action === 'config') {
    if (slug !== 'replace' || !args.includes('--stdin')) throw new Error('配置必须通过 stdin 传入');
    const name = validateSlug(args[3]);
    const bot = bots().find(b => b.slug === name);
    if (!bot) throw new Error('Runtime 不存在');
    const paths = runtimePaths(bot);
    if (status(paths).status !== 'stopped') throw new Error('请先停止 Runtime');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 1_000_000) throw new Error('配置过大'); }
    const request = JSON.parse(input);
    updateJson(paths.config, current => {
      if (JSON.stringify(current) !== JSON.stringify(request.expectedConfig)) throw new Error('配置已被修改，请重试');
      const previous = current as RuntimeConfig;
      const changedWorkspace = previous.project?.path !== request.config.project?.path
        || (previous.project?.workspaceMode || 'per-session-worktree') !== (request.config.project?.workspaceMode || 'per-session-worktree');
      const sessionsFile = path.join(paths.root, 'sessions.json');
      if (changedWorkspace && fs.existsSync(sessionsFile)) {
        const state = read<import('../src/types.js').BridgeState>(sessionsFile);
        const backup = path.join(paths.root, 'backups', `workspace-${Date.now()}-${crypto.randomUUID()}`);
        fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
        saveJson(path.join(backup, 'sessions.json'), state);
        saveJson(path.join(backup, 'feishu-runtime.json'), previous);
        saveJson(path.join(backup, 'runtime.json'), read<BotMetadata>(paths.metadata));
        saveJson(sessionsFile, { ...state, sessions: {}, ...(state.routes ? { routes: {} } : {}) });
      }
      return request.config;
    });
    updateJson<BotMetadata>(paths.metadata, current => ({ ...current,
      workspaceMode: request.config.project?.workspaceMode || 'per-session-worktree',
    }));
    return;
  }
  validateSlug(slug);
  let bot = bots().find(b => b.slug === slug);
  if (action === 'add') {
    if (bot) throw new Error('Runtime 已存在');
    bot = { slug, runtimeId: crypto.randomUUID(), displayName: args[args.indexOf('--name') + 1] || slug, workspaceMode: 'per-session-worktree' };
    const paths = runtimePaths(bot);
    saveJson(paths.metadata, bot);
    saveJson(paths.config, {});
    return json(bot);
  }
  if (!bot) throw new Error('Runtime 不存在，请先 setup');
  const paths = runtimePaths(bot);
  if (action === 'status') return json(status(paths));
  if (action === 'stop') return stop(paths);
  if (action === 'setup') {
    if (status(paths).status !== 'stopped') throw new Error('请先停止 Runtime');
    updateJson<RuntimeConfig>(paths.config, config => {
      const next: RuntimeConfig = { ...config, feishu: { ...config.feishu,
      appId: process.env.FEISHU_APP_ID || config.feishu?.appId,
      appSecret: process.env.FEISHU_APP_SECRET || config.feishu?.appSecret,
      domain: process.env.FEISHU_DOMAIN || config.feishu?.domain || 'feishu',
      allowedUsers: process.env.FEISHU_ALLOWED_USERS?.split(',').map(v => v.trim()).filter(Boolean) || config.feishu?.allowedUsers,
      } };
      assertCredentials(next);
      if (!next.feishu.allowedUsers?.length) throw new Error('请设置 FEISHU_ALLOWED_USERS，使用逗号分隔的飞书 open_id');
      return next;
    }); return;
  }
  if (action === 'doctor') {
    const config = read(paths.config);
    assertCredentials(config);
    if (!config.feishu.allowedUsers?.length) throw new Error('缺少用户白名单');
    return json({ ok: true, ...status(paths) });
  }
  if (!['start', 'restart'].includes(action)) throw new Error('未知 Runtime 命令');
  Object.assign(process.env, resolveServiceEnvironment({ previous: readServiceEnvironment(slug) }));
  if (action === 'restart') await stop(paths);
  if (status(paths).status !== 'stopped') throw new Error('Runtime 已启动');
  if (!args.includes('--foreground')) {
    fs.mkdirSync(path.dirname(paths.log), { recursive: true, mode: 0o700 });
    const log = fs.openSync(paths.log, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'bots', 'start', slug, '--foreground'], {
      detached: true, stdio: ['ignore', log, log], env: process.env,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); fs.closeSync(log); return json({ status: 'starting', pid: child.pid });
  }
  const lock = path.join(paths.root, 'process.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || alive(Number(fs.readFileSync(lock, 'utf8')))) throw new Error('Runtime 已锁定');
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  const processFile = path.join(paths.root, 'process.json');
  let shutdown: (() => void) | undefined;
  const cleanup = () => { shutdown?.(); fs.rmSync(lock, { force: true }); fs.rmSync(processFile, { force: true }); };
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
  saveJson(processFile, { pid: process.pid, ready: false });
  const codex = await ensureLocalCodex();
  process.env.CODEX_PATH = codex.path;
  const config = read(paths.config); assertCredentials(config);
  const { startBridge } = await import('../src/bridge.js');
  shutdown = await startBridge(paths.root, config);
  saveJson(processFile, { pid: process.pid, ready: true });
}
main().catch(error => {
  // Installation errors contain no provider output or credentials.
  console.error('Runtime 操作失败。请检查配置、用户白名单、登录及网络连接。');
  if (/Codex|CODEX_PATH/.test(error.message)) console.error(error.message);
  process.exitCode = 1;
});

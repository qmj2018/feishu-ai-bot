import type { Environment, InstallRunner } from "./types.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_ID } from './identity.js';

const registry = 'https://registry.npmjs.org/';
const stableVersion = /^\d+\.\d+\.\d+$/;

export function localCodexPath(env: Environment = process.env) {
  let file = env.CODEX_PATH ?? path.join(fs.realpathSync(env.HOME || os.homedir()), '.local', 'bin', 'codex');
  if (!env.CODEX_PATH && !fs.existsSync(file)) {
    const located = spawnSync('sh', ['-c', 'command -v codex'], { env, encoding: 'utf8', timeout: 5000 });
    const candidate = located.stdout?.trim();
    if (located.status === 0 && candidate && path.isAbsolute(candidate) && !candidate.endsWith('.exe') && !/^\/mnt\/[a-z]\//i.test(candidate)) file = candidate;
  }
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) {
    throw new Error('CODEX_PATH 必须是无控制字符的绝对路径');
  }
  return file;
}

function execute(command: string, args: string[], options: { env?: Environment; timeout?: number }) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ...result, status: result.error ? 1 : result.status, stdout: result.stdout || '' };
}

export function installedCodexVersion(file: string, env: Environment = process.env, commandRunner: InstallRunner = execute) {
  const result = commandRunner(file, ['--version'], { env, timeout: 10_000 });
  return result.status === 0 ? /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(result.stdout.trim())?.[1] : undefined;
}

function atLeast(current: string, latest: string) {
  const a = current.split(/[.-]/).slice(0, 3).map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return !current.includes('-');
}

async function acquireLock(file: string) {
  const deadline = Date.now() + 240_000;
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { fs.unlinkSync(file); continue; } }
        }
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (Date.now() >= deadline) throw new Error(`等待 Codex 升级锁超时: ${file}`);
      await sleep(200);
    }
  }
}

// Install into a private release directory, validate, then atomically switch the
// requested executable. A failed download never replaces a working installation.
export async function ensureLocalCodex({ env = process.env, log = console.error, update = false }: { env?: Environment; log?: (message: string) => void; update?: boolean } = {}, { commandRunner = execute }: { commandRunner?: InstallRunner } = {}) {
  if (process.platform === 'win32') throw new Error('自动安装 Codex 当前支持 Linux 和 macOS');
  const file = localCodexPath(env);
  const installed = installedCodexVersion(file, env, commandRunner);
  if (installed && !update) {
    log(`复用本机 Codex ${installed}: ${file}（跳过下载和升级）`);
    return { path: file, version: installed, latest: installed, updated: false };
  }
  const home = fs.realpathSync(env.HOME || os.homedir());
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const unlock = await acquireLock(`${file}.ai-bot-update.lock`);
  let release: string | undefined;
  let activated = false;
  try {
    const afterLock = installedCodexVersion(file, env, commandRunner);
    if (afterLock && !update) {
      log(`复用本机 Codex ${afterLock}: ${file}（跳过下载和升级）`);
      return { path: file, version: afterLock, latest: afterLock, updated: false };
    }
    log(`检查本机 Codex 最新稳定版: ${file}`);
    const query = commandRunner('npm', ['view', '@openai/codex', 'dist-tags.latest', '--json', `--registry=${registry}`,
      '--prefer-online', '--offline=false', '--fetch-retries=1', '--fetch-timeout=15000'], { env, timeout: 40_000 });
    let latest;
    try { latest = JSON.parse(query.stdout); } catch { /* Report a bounded, credential-free error below. */ }
    if (query.status !== 0 || typeof latest !== 'string' || !stableVersion.test(latest)) {
      throw new Error('无法从官方 npm 查询 Codex 最新稳定版，请检查 npm、网络和代理后重试');
    }
    const current = installedCodexVersion(file, env, commandRunner);
    if (current && atLeast(current, latest)) {
      log(`本机 Codex ${current} 已满足最新稳定版 ${latest}`);
      return { path: file, version: current, latest, updated: false };
    }
    log(current ? `升级本机 Codex: ${current} → ${latest}` : `安装本机 Codex ${latest}`);
    const releases = path.join(home, '.local', 'share', APP_ID, 'codex');
    fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
    release = fs.mkdtempSync(path.join(releases, `${latest}-`));
    const install = commandRunner('npm', ['install', '--prefix', release, '--no-save', '--package-lock=false',
      '--ignore-scripts', '--no-audit', '--no-fund', '--include=optional', `--registry=${registry}`,
      '--fetch-retries=1', '--fetch-timeout=30000', `@openai/codex@${latest}`], { env, timeout: 180_000 });
    const candidate = path.join(release, 'node_modules', '.bin', 'codex');
    if (install.status !== 0 || installedCodexVersion(candidate, env, commandRunner) !== latest) {
      throw new Error(`Codex ${latest} 安装或可执行文件校验失败；原客户端已保留，请检查网络和目录写权限`);
    }
    const previous = fs.lstatSync(file, { throwIfNoEntry: false });
    if (previous) {
      const backup = `${file}.before-ai-bot-${crypto.randomUUID()}`;
      if (previous.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(file), backup);
      else if (previous.isFile()) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      else throw new Error(`Codex 路径不是可执行文件: ${file}`);
      log(`旧 Codex 入口已备份: ${backup}`);
    }
    const link = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.symlinkSync(candidate, link);
      fs.renameSync(link, file);
    } finally { fs.rmSync(link, { force: true }); }
    activated = true;
    log(`本机 Codex ${latest} 已就绪: ${file}`);
    return { path: file, version: latest, latest, updated: true };
  } finally {
    if (release && !activated) fs.rmSync(release, { recursive: true, force: true });
    unlock();
  }
}

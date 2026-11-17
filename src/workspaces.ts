import type { Environment, CommandRunner } from "./types.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, resolveProjectPath, validateSlug } from './core.js';
import { saveJson } from './storage.js';
import { APP_ID } from './identity.js';
import { LEGACY_APP_ID } from './legacy.js';

export function validateRepository(value: string) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('仓库地址无效');
  if (/^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value)) return value;
  let url; try { url = new URL(value); } catch { throw new Error('请使用 HTTPS 或 SSH Git 仓库地址'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash
    || (url.protocol === 'https:' && url.username) || !url.pathname || url.pathname === '/') {
    throw new Error('请使用不含密码或 Token 的 HTTPS/SSH 仓库地址；认证使用 SSH agent 或 Git credential helper');
  }
  return value;
}

function directory(value: string) {
  const stat = fs.lstatSync(value, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('工作空间路径必须是普通目录');
  return stat;
}

export function prepareWorkspace({ name, repo, empty = false, branch, workspaceRoot,
  env = process.env, commandRunner = run }: { name: string; repo?: string; empty?: boolean; branch?: string; workspaceRoot?: string; env?: Environment; commandRunner?: CommandRunner }) {
  validateSlug(name);
  if (repo) validateRepository(repo);
  if (repo && empty) throw new Error('--repo 和 --empty 不能同时使用');
  const git = (args: string[]) => commandRunner('git', args, { env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
  if (branch !== undefined) {
    if (typeof branch !== 'string' || !branch || branch.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(branch)) throw new Error('分支名无效');
    if (git(['check-ref-format', '--branch', branch]).stdout.trim() !== branch) throw new Error('分支名无效');
  }
  let base = path.resolve(workspaceRoot || path.join(env.HOME || os.homedir(), '.feishu-runtime', 'workspaces'));
  directory(base);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  base = fs.realpathSync(base);
  const root = path.join(base, name);
  const project = path.join(root, 'repo');
  const metadata = path.join(root, 'workspace.json');
  if (directory(root)) {
    const stat = fs.lstatSync(metadata, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('目录已存在但不是本工具管理的工作空间，请使用其他名称');
    const saved = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    if (![APP_ID, LEGACY_APP_ID].includes(saved.managedBy) || saved.name !== name) throw new Error('工作空间元数据无效');
    if ((repo && saved.repo !== repo) || (empty && saved.repo) || (branch && (saved.requestedBranch || saved.branch) !== branch)) throw new Error('已有工作空间的仓库或分支配置不同，请使用新名称');
    resolveProjectPath(project);
    if (saved.repo && git(['-C', project, 'remote', 'get-url', 'origin']).stdout.trim() !== saved.repo) throw new Error('工作空间 origin 已被修改，请先核对');
    git(['-C', project, 'rev-parse', '--verify', 'HEAD']);
    const actualBranch = git(['-C', project, 'branch', '--show-current']).stdout.trim();
    if (branch && actualBranch !== branch) throw new Error('工作空间当前分支已被切换，请核对后重试');
    return { name, root, project, repo: saved.repo, branch: actualBranch, created: false };
  }
  if (!repo && !empty) throw new Error('工作空间不存在，创建时必须指定 --repo 或 --empty');
  const staging = fs.mkdtempSync(path.join(base, `.${name}-`));
  const checkout = path.join(staging, 'repo');
  try {
    if (repo) git(['-c', 'core.hooksPath=/dev/null', 'clone', ...(branch ? ['--branch', branch] : []), '--', repo, checkout]);
    else {
      git(['init', '-b', branch || 'main', checkout]);
      git(['-C', checkout, '-c', 'user.name=Feishu Bot', '-c', 'user.email=feishu-bot@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Initialize workspace']);
    }
    // A committed HEAD is required before a bot can create per-session worktrees.
    git(['-C', checkout, 'rev-parse', '--verify', 'HEAD']);
    const actualBranch = git(['-C', checkout, 'branch', '--show-current']).stdout.trim();
    saveJson(path.join(staging, 'workspace.json'), { managedBy: APP_ID, name, repo: repo || null,
      requestedBranch: branch || null, branch: actualBranch, createdAt: new Date().toISOString() });
    if (fs.existsSync(root)) throw new Error('目标工作空间已被创建，请重试');
    fs.renameSync(staging, root);
    return { name, root, project, repo: repo || null, branch: actualBranch, created: true };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    // Avoid echoing credential-helper / remote-server output into deployment logs.
    throw new Error('创建工作空间失败：请检查 Git 认证、仓库和分支是否存在；已存在的工作空间未被覆盖', { cause: error });
  }
}

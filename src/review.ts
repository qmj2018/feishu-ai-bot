import type { Environment, CommandRunner } from "./types.js";
interface SkillFile { name: string; relative: string; content: Buffer }
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import { run } from "./core.js";
import { APP_ID } from './identity.js';
import { managedSkill } from './legacy.js';

const CODEBASE_HOST = "code.byted.org";
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANAGED_MARKER = `managed-by: ${APP_ID}`;
const MAX_REVIEW_FILES = 200;
const MAX_REVIEW_LINES = 20_000;

export function parseCodebaseMergeRequestUrl(value: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new Error("MR URL 无效");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MR URL 不是有效 URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== CODEBASE_HOST ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error(`只支持 https://${CODEBASE_HOST}/ 上的 MR URL`);
  }
  let parts;
  try {
    parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new Error("MR URL 路径编码无效");
  }
  const marker = parts.lastIndexOf("merge_requests");
  if (marker < 2 || marker + 1 >= parts.length) {
    throw new Error("MR URL 必须包含 <namespace>/<repo>/merge_requests/<number>");
  }
  const repoParts = parts.slice(0, marker);
  if (repoParts.some((part) => !PATH_SEGMENT.test(part) || part === "." || part === "..")) {
    throw new Error("MR URL 中的仓库路径不安全");
  }
  const numberText = parts[marker + 1];
  if (!/^[1-9][0-9]*$/.test(numberText)) throw new Error("MR 编号无效");
  const suffix = parts.slice(marker + 2);
  if (suffix.some((part) => !PATH_SEGMENT.test(part))) throw new Error("MR URL 后缀无效");
  const repoPath = repoParts.join("/");
  const number = Number(numberText);
  return {
    webUrl: `https://${CODEBASE_HOST}/${repoPath}/merge_requests/${number}`,
    repoPath,
    number,
    remoteUrl: `git@${CODEBASE_HOST}:${repoPath}.git`,
    remoteRef: `refs/merge-requests/${number}/tmp-merge`,
  };
}

export function parseMergeParents(output: string) {
  const tokens = output.trim().split(/\s+/);
  if (tokens.length !== 3 || tokens.some((token) => !/^[0-9a-f]{40}$/i.test(token))) {
    throw new Error("Codebase tmp-merge 必须恰好包含 target 和 source 两个父提交");
  }
  return { mergeRevision: tokens[0], targetRevision: tokens[1], sourceRevision: tokens[2] };
}

function cacheRoot(env: Environment) {
  const base = env.XDG_CACHE_HOME
    ? path.resolve(env.XDG_CACHE_HOME)
    : path.join(env.HOME || os.homedir(), ".cache");
  return path.join(base, APP_ID, "mr-review");
}

export function reviewCachePath(repoPath: string, env: Environment = process.env) {
  const digest = crypto.createHash("sha256").update(repoPath).digest("hex").slice(0, 16);
  const label = repoPath.split("/").at(-1)!.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return path.join(cacheRoot(env), `${label}-${digest}.git`);
}

function assertDirectoryNotSymlink(directory: string) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`缓存路径不是安全目录: ${directory}`);
  }
}

function parseNumstat(output: string) {
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  let files = 0;
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const [added, deleted] = line.split("\t", 3);
    files += 1;
    if (added === "-" || deleted === "-") binaryFiles += 1;
    else {
      additions += Number(added);
      deletions += Number(deleted);
    }
  }
  return { files, additions, deletions, binaryFiles, changedLines: additions + deletions };
}

function branchNames(message: string) {
  const match = /^Merge '([^']+)' into '([^']+)'/m.exec(message);
  return match ? { sourceBranch: match[1], targetBranch: match[2] } : {};
}

export function prepareMergeRequestReview(value: string, { env = process.env, commandRunner = run }: { env?: Environment; commandRunner?: CommandRunner } = {}) {
  const mr = parseCodebaseMergeRequestUrl(value);
  const repository = reviewCachePath(mr.repoPath, env);
  const parent = path.dirname(repository);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertDirectoryNotSymlink(parent);
  const existing = fs.lstatSync(repository, { throwIfNoEntry: false });
  if (!existing) {
    commandRunner("git", ["init", "--bare", "--quiet", repository], { env });
    fs.chmodSync(repository, 0o700);
  } else {
    assertDirectoryNotSymlink(repository);
    const bare = commandRunner("git", ["-C", repository, "rev-parse", "--is-bare-repository"], {
      env,
    });
    if (bare.stdout.trim() !== "true") throw new Error(`MR 缓存不是 bare Git 仓库: ${repository}`);
  }
  const localRef = `refs/${APP_ID}/mr/${mr.number}/tmp-merge`;
  try {
    commandRunner(
      "git",
      [
        "-C",
        repository,
        "fetch",
        "--force",
        "--no-tags",
        "--depth=2",
        mr.remoteUrl,
        `+${mr.remoteRef}:${localRef}`,
      ],
      { env },
    );
  } catch (error) {
    throw new Error(
      `无法读取 ${mr.repoPath}!${mr.number}；请检查 MR 是否存在以及 本机 SSH 读权限: ${error.message}`,
      { cause: error },
    );
  }
  const parentLine = commandRunner("git", ["-C", repository, "rev-list", "--parents", "-n", "1", localRef], {
    env,
  }).stdout;
  const revisions = parseMergeParents(parentLine);
  for (const revision of Object.values(revisions)) {
    commandRunner("git", ["-C", repository, "cat-file", "-e", `${revision}^{commit}`], { env });
  }
  const mergeMessage = commandRunner(
    "git",
    ["-C", repository, "show", "-s", "--format=%B", revisions.mergeRevision],
    { env },
  ).stdout;
  const numstat = commandRunner(
    "git",
    ["-C", repository, "diff", "--numstat", revisions.targetRevision, revisions.mergeRevision, "--"],
    { env },
  ).stdout;
  const names = commandRunner(
    "git",
    [
      "-C",
      repository,
      "diff",
      "--name-status",
      "--find-renames",
      revisions.targetRevision,
      revisions.mergeRevision,
      "--",
    ],
    { env },
  ).stdout;
  const stats = parseNumstat(numstat);
  return {
    ...mr,
    ...revisions,
    ...branchNames(mergeMessage),
    repository,
    localRef,
    stats,
    changedFiles: names.trim() ? names.trim().split("\n") : [],
    oversized: stats.files > MAX_REVIEW_FILES || stats.changedLines > MAX_REVIEW_LINES,
    limits: { maxFiles: MAX_REVIEW_FILES, maxChangedLines: MAX_REVIEW_LINES },
    reviewDiffArgs: [
      "git",
      "-C",
      repository,
      "diff",
      "--find-renames",
      revisions.targetRevision,
      revisions.mergeRevision,
      "--",
    ],
  };
}

const REVIEW_SKILLS = ['code-review', 'codebase-mr-review'];
const bundledSkillsRoot = path.join(PROJECT_ROOT, '.agents', 'skills');

function reviewSkillFiles(source = bundledSkillsRoot) {
  // Keep the old source-directory option usable for existing callers.
  const root = REVIEW_SKILLS.includes(path.basename(source)) ? path.dirname(source) : source;
  const files: SkillFile[] = [];
  function visit(directory: string, name: string, relative = ''): void {
    assertDirectoryNotSymlink(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, name, child);
      else if (entry.isFile()) files.push({ name, relative: child, content: fs.readFileSync(file) });
      else throw new Error(`Review skill 资源必须是普通文件或目录: ${file}`);
    }
  }
  for (const name of REVIEW_SKILLS) {
    const directory = path.join(root, name);
    visit(directory, name);
    const entry = files.find(file => file.name === name && file.relative === 'SKILL.md');
    if (!entry?.content.toString().includes(MANAGED_MARKER)) throw new Error(`内置 Review skill 缺少管理标记: ${name}`);
  }
  // Make referenced resources available before activating either entry point.
  return files.sort((a, b) => Number(a.relative === 'SKILL.md') - Number(b.relative === 'SKILL.md'));
}

function assertSkillTarget(root: string, name: string, relative: string) {
  const destination = path.join(root, name);
  const file = path.join(destination, relative);
  for (let directory = path.dirname(file); directory !== path.dirname(root); directory = path.dirname(directory)) {
    assertDirectoryNotSymlink(directory);
  }
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Review skill 目标必须是普通文件: ${file}`);
  return file;
}

export function installReviewSkill({ env = process.env, source = bundledSkillsRoot }: { env?: Environment; source?: string } = {}) {
  const home = path.resolve(env.HOME || os.homedir());
  const root = path.join(home, '.agents', 'skills');
  const files = reviewSkillFiles(source);
  assertDirectoryNotSymlink(path.dirname(root));
  // Check the complete bundle before changing any existing user-level skill.
  for (const name of REVIEW_SKILLS) {
    const file = assertSkillTarget(root, name, 'SKILL.md');
    if (fs.existsSync(path.join(root, name)) &&
      (!fs.existsSync(file) || !managedSkill(fs.readFileSync(file, 'utf8')))) {
      throw new Error(`拒绝覆盖非本工具管理的 skill: ${path.join(root, name)}`);
    }
  }
  for (const file of files) assertSkillTarget(root, file.name, file.relative);
  for (const file of files) {
    const destination = path.join(root, file.name, file.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, file.content, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return path.join(root, 'code-review');
}

export function reviewSkillInstalled(env: Environment = process.env) {
  try {
    const root = path.join(path.resolve(env.HOME || os.homedir()), '.agents', 'skills');
    assertDirectoryNotSymlink(path.dirname(root));
    return reviewSkillFiles().every(file => {
      const destination = assertSkillTarget(root, file.name, file.relative);
      return fs.existsSync(destination) && fs.readFileSync(destination).equals(file.content);
    });
  } catch { return false; }
}

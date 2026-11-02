import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./core.mjs";

const CODEBASE_HOST = "code.byted.org";
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MANAGED_MARKER = "managed-by: devbox-codex-bot";
const MAX_REVIEW_FILES = 200;
const MAX_REVIEW_LINES = 20_000;

export function parseCodebaseMergeRequestUrl(value) {
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

export function parseMergeParents(output) {
  const tokens = output.trim().split(/\s+/);
  if (tokens.length !== 3 || tokens.some((token) => !/^[0-9a-f]{40}$/i.test(token))) {
    throw new Error("Codebase tmp-merge 必须恰好包含 target 和 source 两个父提交");
  }
  return { mergeRevision: tokens[0], targetRevision: tokens[1], sourceRevision: tokens[2] };
}

function cacheRoot(env) {
  const base = env.XDG_CACHE_HOME
    ? path.resolve(env.XDG_CACHE_HOME)
    : path.join(env.HOME || os.homedir(), ".cache");
  return path.join(base, "devbox-codex-bot", "mr-review");
}

export function reviewCachePath(repoPath, env = process.env) {
  const digest = crypto.createHash("sha256").update(repoPath).digest("hex").slice(0, 16);
  const label = repoPath.split("/").at(-1).replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return path.join(cacheRoot(env), `${label}-${digest}.git`);
}

function assertDirectoryNotSymlink(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`缓存路径不是安全目录: ${directory}`);
  }
}

function parseNumstat(output) {
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

function branchNames(message) {
  const match = /^Merge '([^']+)' into '([^']+)'/m.exec(message);
  return match ? { sourceBranch: match[1], targetBranch: match[2] } : {};
}

export function prepareMergeRequestReview(value, { env = process.env, commandRunner = run } = {}) {
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
  const localRef = `refs/devbox-codex-bot/mr/${mr.number}/tmp-merge`;
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
      `无法读取 ${mr.repoPath}!${mr.number}；请检查 MR 是否存在以及 Devbox SSH 读权限: ${error.message}`,
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

function bundledSkillDirectory() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.agents/skills/codebase-mr-review",
  );
}

export function installReviewSkill({ env = process.env, source = bundledSkillDirectory() } = {}) {
  const home = env.HOME || os.homedir();
  const destination = path.join(home, ".agents", "skills", "codebase-mr-review");
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing) {
    assertDirectoryNotSymlink(destination);
    const current = fs.readFileSync(path.join(destination, "SKILL.md"), "utf8");
    if (!current.includes(MANAGED_MARKER)) {
      throw new Error(`拒绝覆盖非本工具管理的 skill: ${destination}`);
    }
  }
  const sourceSkill = fs.readFileSync(path.join(source, "SKILL.md"), "utf8");
  if (!sourceSkill.includes(MANAGED_MARKER)) throw new Error("内置 MR Review skill 缺少管理标记");
  fs.mkdirSync(path.join(destination, "agents"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(destination, "SKILL.md"), sourceSkill, { mode: 0o600 });
  fs.copyFileSync(
    path.join(source, "agents", "openai.yaml"),
    path.join(destination, "agents", "openai.yaml"),
  );
  fs.chmodSync(path.join(destination, "agents", "openai.yaml"), 0o600);
  return destination;
}

export function reviewSkillInstalled(env = process.env) {
  const file = path.join(env.HOME || os.homedir(), ".agents", "skills", "codebase-mr-review", "SKILL.md");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return Boolean(stat?.isFile() && !stat.isSymbolicLink() && fs.readFileSync(file, "utf8").includes(MANAGED_MARKER));
}

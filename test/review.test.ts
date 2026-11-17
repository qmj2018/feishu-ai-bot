import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LEGACY_APP_ID } from '../src/legacy.js';
import {
  installReviewSkill,
  parseCodebaseMergeRequestUrl,
  parseMergeParents,
  prepareMergeRequestReview,
  reviewSkillInstalled,
} from "../src/review.js";

test("parseCodebaseMergeRequestUrl accepts nested Codebase MR URLs", () => {
  assert.deepEqual(
    parseCodebaseMergeRequestUrl("https://code.byted.org/ee/bitable-sdk/merge_requests/62168/diffs"),
    {
      webUrl: "https://code.byted.org/ee/bitable-sdk/merge_requests/62168",
      repoPath: "ee/bitable-sdk",
      number: 62168,
      remoteUrl: "git@code.byted.org:ee/bitable-sdk.git",
      remoteRef: "refs/merge-requests/62168/tmp-merge",
    },
  );
});

test("parseCodebaseMergeRequestUrl rejects other hosts and malformed paths", () => {
  for (const value of [
    "http://code.byted.org/ee/repo/merge_requests/1",
    "https://evil.example/ee/repo/merge_requests/1",
    "https://code.byted.org/repo/merge_requests/1",
    "https://code.byted.org/ee/repo/merge_requests/0",
    "https://user@code.byted.org/ee/repo/merge_requests/1",
  ]) {
    assert.throws(() => parseCodebaseMergeRequestUrl(value));
  }
});

test("parseMergeParents requires a two-parent merge commit", () => {
  const merge = "a".repeat(40);
  const target = "b".repeat(40);
  const source = "c".repeat(40);
  assert.deepEqual(parseMergeParents(`${merge} ${target} ${source}\n`), {
    mergeRevision: merge,
    targetRevision: target,
    sourceRevision: source,
  });
  assert.throws(() => parseMergeParents(`${merge} ${target}\n`));
});

test("prepareMergeRequestReview fetches immutable revisions and reports size", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-review-home-"));
  const merge = "a".repeat(40);
  const target = "b".repeat(40);
  const source = "c".repeat(40);
  const calls = [];
  const commandRunner = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "init") fs.mkdirSync(args.at(-1), { recursive: true });
    if (args.includes("rev-list")) return { status: 0, stdout: `${merge} ${target} ${source}\n`, stderr: "" };
    if (args.includes("--format=%B")) {
      return { status: 0, stdout: "Merge 'feature' into 'develop'\n", stderr: "" };
    }
    if (args.includes("--numstat")) return { status: 0, stdout: "10\t2\tsrc/a.js\n-\t-\tlogo.png\n", stderr: "" };
    if (args.includes("--name-status")) return { status: 0, stdout: "M\tsrc/a.js\nA\tlogo.png\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = prepareMergeRequestReview(
    "https://code.byted.org/ee/repo/merge_requests/7",
    { env: { HOME: home }, commandRunner },
  );
  assert.equal(result.targetBranch, "develop");
  assert.equal(result.sourceBranch, "feature");
  assert.deepEqual(result.stats, {
    files: 2,
    additions: 10,
    deletions: 2,
    binaryFiles: 1,
    changedLines: 12,
  });
  assert.equal(result.oversized, false);
  assert.ok(
    calls.some(([, args]) =>
      args.some((arg) =>
        arg.includes("refs/merge-requests/7/tmp-merge:refs/feishu-ai-bot/mr/7/tmp-merge"),
      ),
    ),
  );
});

test("installReviewSkill installs both entry points and their referenced resources", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-review-skill-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.resolve(".agents/skills/codebase-mr-review");
  const destination = installReviewSkill({ env: { HOME: home }, source });
  assert.equal(path.basename(destination), 'code-review');
  assert.equal(reviewSkillInstalled({ HOME: home }), true);
  for (const name of ['code-review', 'codebase-mr-review']) {
    const directory = path.join(home, '.agents/skills', name);
    const entry = path.join(directory, 'SKILL.md');
    const text = fs.readFileSync(entry, 'utf8');
    for (const [, relative] of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
      assert.equal(fs.statSync(path.resolve(directory, relative)).isFile(), true);
    }
    assert.equal(fs.statSync(entry).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(directory, 'agents/openai.yaml')).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readFileSync(path.join(destination, 'references/codebase.md')),
    fs.readFileSync('.agents/skills/code-review/references/codebase.md'));
  fs.writeFileSync(path.join(destination, "SKILL.md"), "user-owned\n");
  assert.equal(reviewSkillInstalled({ HOME: home }), false);
  assert.throws(() => installReviewSkill({ env: { HOME: home }, source }), /拒绝覆盖/);
});

test('installReviewSkill upgrades a legacy installation and detects outdated resources', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-review-upgrade-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacy = path.join(home, '.agents/skills/codebase-mr-review');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), `---\nmetadata:\n  managed-by: ${LEGACY_APP_ID}\n---\nPrevious review workflow\n`);
  fs.writeFileSync(path.join(legacy, 'notes.txt'), 'personal notes');
  assert.equal(reviewSkillInstalled({ HOME: home }), false);
  const destination = installReviewSkill({ env: { HOME: home } });
  assert.equal(reviewSkillInstalled({ HOME: home }), true);
  assert.equal(fs.readFileSync(path.join(legacy, 'notes.txt'), 'utf8'), 'personal notes');
  fs.writeFileSync(path.join(destination, 'references/codebase.md'), 'stale adapter');
  assert.equal(reviewSkillInstalled({ HOME: home }), false);
  installReviewSkill({ env: { HOME: home } });
  assert.equal(reviewSkillInstalled({ HOME: home }), true);
});

test('an unmanaged legacy skill prevents any partial installation of the bundle', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-review-collision-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacy = path.join(home, '.agents/skills/codebase-mr-review');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'user-owned');
  assert.throws(() => installReviewSkill({ env: { HOME: home } }), /拒绝覆盖/);
  assert.equal(fs.readFileSync(path.join(legacy, 'SKILL.md'), 'utf8'), 'user-owned');
  assert.equal(fs.existsSync(path.join(home, '.agents/skills/code-review')), false);
});

test('skill installation refuses symlinked destination resources without altering their targets', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-review-symlink-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const destination = installReviewSkill({ env: { HOME: home } });
  const references = path.join(destination, 'references');
  const outside = path.join(home, 'personal-files');
  fs.renameSync(references, outside);
  const victim = path.join(outside, 'codebase.md');
  fs.writeFileSync(victim, 'personal file');
  fs.symlinkSync(outside, references);
  assert.equal(reviewSkillInstalled({ HOME: home }), false);
  assert.throws(() => installReviewSkill({ env: { HOME: home } }), /安全目录/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'personal file');
});

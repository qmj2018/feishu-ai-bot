import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installReviewSkill,
  parseCodebaseMergeRequestUrl,
  parseMergeParents,
  prepareMergeRequestReview,
  reviewSkillInstalled,
} from "../src/review.mjs";

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devbox-review-home-"));
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
        arg.includes("refs/merge-requests/7/tmp-merge:refs/devbox-codex-bot/mr/7/tmp-merge"),
      ),
    ),
  );
});

test("installReviewSkill installs a managed user-level skill and refuses unmanaged overwrite", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devbox-review-skill-home-"));
  const source = path.resolve(".agents/skills/codebase-mr-review");
  const destination = installReviewSkill({ env: { HOME: home }, source });
  assert.equal(reviewSkillInstalled({ HOME: home }), true);
  assert.match(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), /managed-by: devbox-codex-bot/);
  fs.writeFileSync(path.join(destination, "SKILL.md"), "user-owned\n");
  assert.throws(() => installReviewSkill({ env: { HOME: home }, source }), /拒绝覆盖/);
});

---
name: codebase-mr-review
description: Review a ByteDance Codebase merge request when a user provides a code.byted.org MR link and asks for review, CR, code review, 审查代码, or 检查 MR. Return findings to the requesting conversation; do not publish Codebase comments.
metadata:
  managed-by: devbox-codex-bot
---

# Codebase MR Review

Review the exact revisions represented by a Codebase MR without modifying a working tree.

## Prepare the MR

1. Extract one `https://code.byted.org/<namespace>/<repo>/merge_requests/<number>` URL.
2. Run `devbox-codex-bot mr prepare '<url>' --json`.
3. Treat the returned `targetRevision`, `sourceRevision`, and `mergeRevision` as immutable inputs for this review. Do not replace them with branch heads.
4. If preparation reports missing Git access or a missing `tmp-merge` ref, report that blocker. Do not guess the target branch.

The command creates or updates a bare cache under the current user's cache directory. It does not checkout or execute MR code.

## Review safely

- Start from `changedFiles` and `stats`.
- Inspect the effective change with the returned `reviewDiffArgs`. Add paths after the final `--` to review files in manageable batches.
- Read source-side context with `git -C <repository> show <mergeRevision>:<path>` and base context with `git -C <repository> show <targetRevision>:<path>`.
- Check applicable repository instructions when present. Read the root `AGENTS.md`, then any `AGENTS.md` files in parent directories of changed files from `mergeRevision`.
- Review correctness, regressions, security, data loss, concurrency, error handling, compatibility, and missing tests. Avoid style-only findings unless they materially affect maintainability.
- Static analysis is the default. Do not checkout the MR, execute its scripts, install its dependencies, or run its tests unless the user explicitly asks and approves executing untrusted MR code.
- Do not edit files, push branches, approve the MR, or create Codebase comments. A request to publish comments is a separate external write and requires fresh explicit authorization.

If `oversized` is true, split the review by subsystem or risk. State which files were reviewed and which remain; never imply full coverage after sampling.

## Response format

Lead with findings, ordered by severity. Each finding must include:

- severity: `P0`, `P1`, `P2`, or `P3`;
- file and source-side line number when available;
- the concrete failure scenario and impact;
- a minimal fix direction.

Then provide a short coverage summary with MR revisions and validation limitations. If no actionable findings remain, say so explicitly and mention residual testing risk.

# Codebase MR input

Use only for `https://code.byted.org/<namespace>/<repo>/merge_requests/<number>`.
This adapter supplies review inputs; apply the shared repository discovery,
evidence and reporting workflow in [code-review](../SKILL.md).

1. Run `feishu-ai-bot mr prepare '<url>' --json` when the CLI is available.
   It fetches a bare cache without changing the bot's configured project or
   checking out MR code. If only a feishu-ai-bot checkout is available, use
   `node /path/to/feishu-ai-bot/dist/bin/feishu-ai-bot.js mr prepare '<url>' --json`.
2. Pin the returned `repository`, `targetRevision`, `sourceRevision` and
   `mergeRevision`. `tmp-merge` must have target then source as its two parents;
   the effective change is `targetRevision` to `mergeRevision`, not an assumed
   branch head. Missing Git access or a missing ref is a blocker for those inputs.
3. Start from `changedFiles` and `stats`. Run the returned `reviewDiffArgs` with
   `--no-ext-diff --no-textconv` before its final `--`; add selected paths after
   that separator to inspect manageable batches.
4. Read candidate files and applicable instructions with
   `git -C <repository> show <mergeRevision>:<path>` and base files with
   `git -C <repository> show <targetRevision>:<path>`. For a rename, check both
   paths and their directory instructions. Cite candidate-side lines from the
   merge result and identify those revision semantics in the coverage note.
5. When `oversized` is true, track subsystem coverage and remaining paths. The
   size flag does not authorize skipping files while claiming a complete review.

The helper and a review request do not authorize publishing comments, approving
the MR, executing its code or changing its source branch. Reuse explicit task
authorization if the user separately requests any of these actions.

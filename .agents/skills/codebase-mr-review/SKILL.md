---
name: codebase-mr-review
description: Review a ByteDance Codebase merge request when a user provides a code.byted.org MR link and asks for review, CR, code review, 审查代码, or 检查 MR. Return findings to the requesting conversation; do not publish Codebase comments.
metadata:
  managed-by: feishu-ai-bot
---

# Codebase MR Review

This is the Codebase URL entry point for the shared review workflow maintained
in feishu-ai-bot. It is installed together with the sibling `code-review` skill.

Read [code-review](../code-review/SKILL.md) for repository discovery, defect
verification and reporting, then use its [Codebase adapter](../code-review/references/codebase.md)
to prepare the exact MR revisions. Apply the target repository's own contracts
and directory instructions, regardless of the bot's configured project.

Return findings to the requesting conversation. Reuse the user's explicit task
authorization for any separately requested mutation or publication; this entry
point does not grant it.

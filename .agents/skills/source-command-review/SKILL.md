---
name: "source-command-review"
description: "Migrated source command `review`"
---

# source-command-review

Use this skill when the user asks to run the migrated source command `review`.

## Command Template

Review the current diff (git diff main...HEAD) as a strict senior engineer:
1) Check against the invariants in AGENTS.md (privacy tiers, no per-student engagement, embeddings-only, contract conformance).
2) Flag missing tests for any logic change.
3) Flag any new dependency or architectural drift (module ceiling = 10).
Output: blocking issues, then nits. Do not change code unless I say so.

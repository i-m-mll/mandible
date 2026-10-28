---
name: mandible
description: Use Mandible to inspect and update its local issue ledger, artifacts, approval requests, and indexed agent conversations. Applies when the user requests Mandible operations or the project uses Mandible for coordination.
---

# Mandible

Mandible is a local agent operations manager. Its app and CLI share the same ledger.
Use `mandible help` to discover commands and `mandible help <command>` for exact syntax.
If the shortcut is unavailable, use the installed command shown in Mandible Settings → Agent integrations.

Before changing an existing issue, read `mandible issue report <id>` and preserve its current intent.
Search with `mandible issue search <words>` before creating a duplicate.
Use short entity IDs in discussion. Use authored references such as `[issue:<id>]` in ledger text.

Issue records describe work. Artifacts retain versioned files. Briefings present artifacts for review.
Approval requests guard actions requiring human approval; submitting a request does not grant approval.
Conversation commands inspect the normalized index; `mandible logs` reads provider-native transcripts.

Follow the user's and project's own policies for roles, branches, worktrees, signing, and approvals.
This skill does not install integrations or change those policies.

Co-Authored-By: Codex (GPT) <codex@openai.com>

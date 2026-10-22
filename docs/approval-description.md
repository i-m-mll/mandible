# Approval Description

Every new approval carries one authored Description explaining the action being approved. It must contain non-whitespace text. The queue validates it before Git observations or request writes; the API, CLI, channel tool and internal producers follow the same contract. Replacing a request requires a new valid Description. Editing Description follows the normal pending-request revision path and invalidates an earlier approval proof.

`mandible auth request` accepts `--message <text>` or `--message-file <file>` for every supported action. Non-merge actions use ordinary explanatory Markdown. `--verification`, protected-root policy, handoff and issue-closure options belong only to merge requests.

A merge uses the same document as its exact reviewed Git message. The CLI composes the merge subject and structured Verification section, then the daemon canonicalizes and hashes those exact bytes. Description is the readable rendering of that document; Exact Git message exposes the bound bytes. Other actions do not receive an inferred Git message.

The browser displays Description read-only. Description and Exact Git disclosure choices persist as browser-local view state per canonical request, independently of backend refreshes and selection changes. Ordinary local browser access does not supply the durable credential and custody preconditions required by the existing revision endpoint. Authorized API revisions retain their existing credential, lifecycle and custody checks; the browser does not infer recovery authority.

The API and database retain the historical `commit_message` key as the single Description authority. `commit_message_digest` retains its existing meaning for canonical Git bytes. No additional authored explanation, derived database column or backfill exists. `diff_summary` remains diff content and cannot substitute for Description. Command, working directory, action type and execution context remain separate exact approval evidence.

Historical requests retain their original text, null values, snapshot keys and signed evidence. Reading a historical request never creates or normalizes Description. The approval view explicitly identifies missing historical text. Existing pending or approved requests remain under their original authorization contract; the new requirement applies to new submissions and newly authored Description revisions.

Co-Authored-By: Codex (GPT) <codex@openai.com>

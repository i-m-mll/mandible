# Approval Description

Every new approval carries one authored Description explaining the action being approved. It must contain non-whitespace text. The queue validates it before Git observations or request writes; the API, CLI and internal producers follow the same contract. Replacing a request requires a new valid Description. Editing Description follows the normal pending-request revision path and invalidates an earlier approval proof.

`mandible auth request` accepts `--message <text>` or `--message-file <file>` for every supported action. Non-merge actions use ordinary explanatory Markdown. `--verification`, protected-root policy, handoff and issue-closure options belong only to merge requests.

A merge uses the same document as its exact reviewed Git message. The CLI composes the merge subject and structured Verification section, then the daemon canonicalizes and hashes those exact bytes. Description is the sole review display of that document. Other actions do not receive an inferred Git message.

A merge author can attach a separate Markdown narrative with `--narrative <file>`. Put each reason before a change directive. The directive names a file in the revision's inventory and quotes the exact proposed text on the next line. The quote must occur exactly once in that file for the directive to open the editable change. Mandible derives the current text from the pinned comparison. The narrative and file list share the same drafts.

```markdown
:::change{path="instructions.md"}
The exact proposed wording.
:::
```

The browser displays the Description as selectable Markdown. A revision to its canonical bytes requires the current responsible actor and the lifecycle and responsibility preconditions. Its disclosure choice persists as browser-local view state per request. The narrative, comment ranges, and draft wording are review data and do not change the canonical merge message.

The API and database retain `commit_message` as the Description authority. `commit_message_digest` identifies canonical Git bytes, and the separate narrative is bound to its reviewed revision. Command, working directory, action type, and execution context remain separate approval evidence.

Historical requests retain their original text, null values, snapshot keys and signed evidence. Reading a historical request never creates or normalizes Description. The approval view explicitly identifies missing historical text. Existing pending or approved requests remain under their original authorization contract; the new requirement applies to new submissions and newly authored Description revisions.

Co-Authored-By: Codex (GPT) <codex@openai.com>

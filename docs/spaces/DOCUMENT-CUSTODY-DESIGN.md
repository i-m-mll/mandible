# Spaces document authoring and publication

Spaces documents are editable managed block trees. Git versions and attachment versions are immutable material that can be read, reviewed, downloaded, or imported as a separate managed document. Editing a managed copy never changes the source version.

Publication has two explicit actions. Preparing freezes the saved document revision, including embedded snapshots and block/view metadata, and records the selected destination's current hash. The user reviews those exact bytes before submitting. Submitting creates an issue-linked feature worktree with the general `wt` mechanism, writes the frozen bytes, signs through `commit-linked`, records a Git-custodied artifact version with the managed snapshot as provenance, and requests protected delivery through the existing auth queue. Human approval remains required. Managed editing continues independently throughout this process.

Before every submission attempt, including a retry after a commit succeeded, the selected destination must still match its prepared hash and the signed artifact and proposal file must match the frozen source. Destination changes cause a refusal. Signing or submission failure retains the snapshot, proposal checkout, and managed draft. Retrying checks the same frozen proposal; an existing request must review its exact signed commit. No background read changes authoring authority, exports current edits, provisions a checkout, or chooses a content winner.

Document reads require caller read access to the source project. Preparing and submitting require write access to the draft project and selected destination project. Imports require read access to the artifact associations and any Git custody project, plus write access to the new document project. Lists omit inaccessible destinations, publications, and history; a checkout registration never grants access.

Schema 190 preserves legacy managed blocks, pre-export and last-export snapshot references, exact published Git content, current checkout HEAD content, and current document file content separately. Legacy export rows remain immutable provenance with no live synchronization consumer. Every checkout stays in place, including ignored and untracked files. Unreachable material remains visibly unavailable with its source details retained. Migration runs transactionally and does not choose a winner by timestamp.

The publication history view uses the shared detail shell and header. Its selected snapshot and inputs are browser-local state; document blocks remain the existing managed authoring representation. Historical content can be imported as a separate copy. Explicit download and local export remain available without a synchronization relationship.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

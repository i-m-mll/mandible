# Preview output lifetime

A preview run records its canonical project, delivery work unit, instance, root
identity and owned output paths in `metadata.json` before producing a snapshot.
The owner file uses `mandible-owned-run@1`. Lifecycle operations serialize on one
sibling lock; an interrupted lock requires inspection of its recorded process.
Missing or old ownership metadata never grants cleanup permission.

Seed output is generated and disposable until the daemon is made writable.
Ordinary writable previews may contain unique ledger, document, preferences and
managed artifact bytes. Process exit, age, a newer snapshot and a code merge do
not dispose of those bytes. Cleanup preserves them and reports the owner action.
Automated fixtures may explicitly declare their mutations disposable with
`--disposable-fixture`; ordinary previews never acquire that flag automatically.

The launcher installs the pinned Bun version through `scripts/bun-runtime.sh`,
uses frozen `bun.lock` installation with clonefile storage, and builds and launches
with that runtime. Shared/symlinked `node_modules` is refused. The source extractor
estimates the selected snapshot, including its existing 128 MiB safety margin.
The preview policy `mandible-preview-budget@1` reserves 512 MiB of free volume
space and limits prospective preview intermediates to 2 GiB across this cache.
These are allocation limits, never deletion permission. Existing protected or
unowned material causes an actionable refusal when it prevents new allocation.

After stopping the exact preview and resolving all owning work, finalize it:

```sh
bun scripts/iab-preview.mjs finalize --root /absolute/preview/root \
  --revision 3 --outcome accepted --converged \
  --disposition transferred --destination /absolute/accepted/material \
  --transfer-reference artifact-version:accepted-version \
  --summary 'Accepted output and verification result' --json
```

Accepted delivery requires completed convergence. `assessed` is a completed
premerge check, not accepted delivery. `failed` and `abandoned` are terminal owner
verdicts. Transfer checks the exact interactive files, including database WAL,
managed files and link bytes, against already materialized intended output named by its established Git or Mandible
custody reference outside
the cleanup root. It does not copy a preview into an indefinite archive or merge
preview ledger edits into production. Explicit owner discard uses
`--disposition discard`; unresolved interactive material blocks finalization.

An investigation names its need and delivery work-unit owner and has a review
deadline within seven days:

```sh
bun scripts/iab-preview.mjs finalize --root /absolute/preview/root \
  --revision 3 --outcome investigating --review-by 2026-10-06T18:00:00Z \
  --summary 'Reproduce the failed interaction' --json
```

Until that deadline the run is pre-acceptance work. On expiry, an apply pass saves
a compact failure outcome and reclaims only generated material after consumer
checks; unresolved interactive edits remain an actionable owner item. Retention
beyond accepted delivery requires an explicit project-instruction exception.

Finalization saves a compact outcome in the sibling `.receipts/` directory before
unlinking outputs. Cleanup verifies root identity, metadata revision, terminal
outcome, receipt, file identities and interactive hashes, and refuses active PIDs,
occupied ports, registered services that can respawn, or failed open-file
inspection. Links are enumerated as links; cleanup never follows their targets.
Only enumerated disposed children are removed. Unknown files keep the directory
and owner record for recovery. A partial cleanup retries remaining paths without
repeating publication, transfer or merge.

```sh
bun scripts/iab-preview.mjs cleanup --apply --json
```

A pass examines at most 64 cache entries and yields between entries. Root-level
unowned snapshots and legacy preview directories remain preserved. No worktree,
conversation custody, historical artifact, backup or legacy operational-log
reclamation occurs here.

Preview stdout and stderr use their own instance paths and the daemon's configured
rotation bounds: 16 MiB and five segments by default. Persisted operational-log
retention remains seven days by default and honors explicit settings. Shutdown
waits for in-flight retention before closing its database. Failed legacy
verification blocks retention. Startup never performs blocking `VACUUM`.

Reports count apparent bytes unlinked; they do not claim measured physical APFS
recovery. Compact receipts remain outside the removed intermediate root.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

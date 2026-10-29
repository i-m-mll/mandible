# Default validation gate

The default suite guards approval custody, CLI runtime qualification, copied-preview capability enforcement, and bounded self-merge restart. Its last complete baseline passed 416 of 423 files and 2,921 of 2,947 tests in 57.98 seconds of runner wall time. The 26 failures came from four causes:

- Accepted-release fixtures omitted the package owner's metadata, failing before custody and approval assertions ran.
- The copied CLI fixture omitted the public dispatcher's `cli/main.zsh`, while one SQLite expectation treated a Bun-only helper as the full selector.
- The Work preview test depended on a decorative plus sign absent from the control's accessible name.
- The self-merge drain test required a removed two-second delay; the production drain also retained a deadline timer after early settlement.

The repair keeps tests for observable custody, qualification, capability, and restart behavior. It corrects fixture ownership and removes assertions on incidental timing and presentation. The drain deadline is now cleared when the wait settles, including failed admission and restart paths.

## Validation

- The auth worker passed 99 focused checks across six files; the CLI and preview worker passed 12 across two files.
- `bun run check` and the backend, channel, and UI typechecks passed on the integrated branch.
- The timed full default gate passed 423 of 423 files and 2,944 of 2,944 tests. Runner wall was 59.75 seconds, external elapsed time was 59.81 seconds, total charged occupancy was 580.69 seconds, and the slowest file occupied 18.62 seconds. The timing gate reported no violations and the checkout remained clean apart from this audit note.

The external time has little margin against the one-minute limit. This run establishes a pass for this candidate; it does not establish repeatability under different machine load. The package and production-runtime acceptance is a separate exact-candidate gate.

Co-Authored-By: Codex (GPT) <codex@openai.com>

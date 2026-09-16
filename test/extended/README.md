# `test/extended/` — green, on demand

`npm run test:extended`

The top-level runner caps V8 old space at 512 MB, keeps one Vitest worker with
file parallelism disabled, and starts a fresh process for each test file. It
runs the launcher shards only after every ordinary file exits, and terminates
any phase if the complete branch-test process tree reaches 950,000 KiB aggregate
RSS. The watchdog controller is outside that measured tree. It reports each
phase's measured peak.

## Provisioned macOS CA lock proof

`local-ca-lockf.test.ts` exercises the real macOS `lockf` setup boundary,
separate-process SIGKILL windows, and an independently live child compiled by
Xcode Command Line Tools (`/usr/bin/clang`). Run it serially with
`npm run test:extended -- --ordinary-only test/extended/local-ca-lockf.test.ts`
on a provisioned macOS host. The maintained full extended command includes it
on macOS; on other platforms its exact file is omitted because those OS
primitives do not exist. An explicit request to run the file on an unprovisioned
host fails visibly. This classification is by external provisioning, not by a
test failure. The portable receipt, drift, denial, and custody state-machine
checks remain in flat `test/local-ca-trust.test.ts` with a mocked lock adapter.

`iab-preview-launcher.test.ts` remains part of this maintained command, but is
run one test declaration per fresh process by `scripts/run-iab-preview-tests.mjs`.
Its process, SQLite, and copied-artifact fixtures retain enough native and V8
memory across a monolithic run to exceed 1 GB. The shard runner discovers every
`it`/`it.each` declaration from the file, caps each Vitest process at a 384 MB
heap, and terminates a shard if the runner plus its full process tree reaches
950,000 KiB RSS. The ordinary extended Vitest invocation excludes exactly that
file so it is never run twice or allowed to overlap another compiler/test gate.

## Inherited baseline exclusions

The maintained command also excludes the following exact files. On 2026-09-14,
an unchanged `main` checkout failed 7 assertions across these 6 files. Each file
in this branch is byte-identical to that checkout; the SHA-256 value makes the
exclusion fail visibly as a documented baseline rather than silently treating a
branch regression as inherited.

`scripts/check-extended-baseline.mjs` verifies every hash before Vitest starts.

Two additional unchanged files are excluded for a measured resource constraint:

| File | SHA-256 |
| --- | --- |
| `artifact-ingest-pool.test.ts` | `2801d65c4724dad369b4bafa06ea59e285a3870533a260740a4e2d1093494f69` |
| `briefing-demo-seed.test.ts` | `b7fd6c37afa1c283307f3635b8ccf775f7ce4068876887a83faaeed18682f64a` |

On this host, each file exceeds the 950,000 KiB aggregate RSS ceiling when run
alone. The artifact file also fails during module import with a lower heap even
when node-only, without a redundant fork, and with the application pool reduced
to one test worker. Changing either file requires removing its exclusion and
establishing a maintained under-cap execution path.

| File | `main` failures | SHA-256 |
| --- | ---: | --- |
| `auth-history-summary.test.ts` | 1 | `d9d1d5e9832a1186473f0e0d372e3133cc2303886bf869fe66f8c8f9e25d9909` |
| `conversation-search-route.test.ts` | 1 | `3bf31d56681edd5f77b52cdfa4f8da9a9e48ef8df1353c1f1505b81204702c07` |
| `inbox-view.test.tsx` | 2 | `3200e45ed1de1da4b6ec9d05d38c6c1c46a9d46bafd0cb9fcd9355049087aad8` |
| `project-db-snapshot.test.ts` | 1 | `4e1e14aeea7517ad387d40a1c98e1ffe97cc1fa7cc1015341fdfb6565871d0c5` |
| `rich-chat-pane.test.tsx` | 1 | `edbd2d1ce4c208c7e0424d12d67bc404f40a835584d727973eee31a3542d65b9` |
| `view-sidebar.test.tsx` | 1 | `d72c522d2922de4227efde3ef6effc71f295d948514eab695562e0ca941d5e12` |

Changing any listed file requires removing it from this table and the config
exclusion, then making its maintained assertions green or moving a still-useful
regression to `test/quarantine/` against an open issue.

The original corpus here was moved by one rule, not adjudicated one by one; the
provisioned macOS proof above was added later for its explicit OS dependency.
A file is in the default gate (`npm test`) only if it is on the whitelist in
[`../README.md`](../README.md); everything else is here. The rules that placed
these files, in order:

| Rule | Count |
| --- | --- |
| Renders Preact (`.tsx`) | 65 |
| Imports `ui/src/…` and never `src/…` | 30 |
| Everything not on the whitelist | 152 |

Two facts hold for every file in this directory, and they are what make the
boundary checkable rather than a promise:

- **Everything exercised is green.** `npm run test:extended` must pass. Nothing red is admitted
  here — a red test is either deleted with its file or extracted into
  `test/quarantine/` against an open issue. The byte-pinned inherited and
  resource baselines above are the only explicit exceptions.
- **Nothing was moved because it failed.** Classification ran before anyone
  looked at which files were red. A file is here because it is not on a
  whitelisted boundary, never because of its colour.

Ordinary non-whitelist files have no per-file reason here; adding one for each
would recreate the archaeology the whitelist exists to avoid. The macOS case
above records its external provisioning requirement. Failure reasons belong in
`test/quarantine/`, not in this green suite.

## Coming back

A test returns to the default suite only when all three hold:

1. It names a defect that actually escaped — to a user, an agent, or a merge —
   or it covers a whitelisted boundary no core file covers.
2. Its failure would name that defect rather than report a changed string.
3. It adds under one second to the wall clock.

Each readmission gets one line in [`../README.md`](../README.md) naming the
incident or boundary that justified it. A test that cannot be justified in one
line does not come back.

## Expiry

Ordinary exploratory files not promoted within 90 days are deleted. Git retains
them either way. The provisioned macOS lock proof above remains a maintained
boundary while local CA setup uses that OS primitive; retire it only when an
equivalent maintained proof replaces it.

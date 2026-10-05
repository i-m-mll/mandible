# Bun execution and SQLite foundation

Mandible uses the exact upstream Bun candidate `900eae300` for dependency management and JavaScript execution. The executable reports version `1.4.3` and revision label `1.4.3-canary.1+900eae300`; this is a qualified prerelease build. `.bun-version` and `package.json` declare the reported version. `scripts/bun-runtime-lock.tsv` pins its full source revision, platform archives, executable checksums, upstream URLs, and execution evidence. The selector verifies bytes before executing version and full revision checks. `MANDIBLE_RUNTIME` follows those same checks.

The immutable cache path includes the full revision and executable checksum. `MANDIBLE_RUNTIME_ARCHIVE` supplies a preserved platform ZIP for offline installation; a portable kit may instead place that ZIP under `runtime/`. The packaged desktop app supplies its bundled archive through the same selector. Neither offline path needs a running daemon or network access. An unavailable upstream artifact fails with offline recovery instructions. Corrupt cache entries are preserved and refused. There is no fallback to the released 1.4.2 runtime, whose native SQLite close retains database handles while statement wrappers remain reachable.

The upstream build is [Buildkite 113725](https://buildkite.com/bun/bun/builds/113725), from [the exact source revision](https://github.com/oven-sh/bun/tree/900eae3009991d27a524a8c0d54f9ed66e4acef4). It includes 81 commits and changes 432 files relative to Bun 1.4.2, including fixes beyond SQLite. Its upstream archives expire on 2027-03-09; the original archive and portable kit must remain in durable custody. macOS arm64 has execution evidence. The other three archive and binary identities are verified but unexecuted; x64 archives require AVX2 because this build provides no baseline archive.

For a clean checkout or worktree:

```sh
runtime=$(scripts/bun-runtime.sh)
PATH="$(dirname "$runtime"):$PATH" "$runtime" install --frozen-lockfile --backend clonefile
PATH="$(dirname "$runtime"):$PATH" "$runtime" run --bun build
```

Each checkout owns a real `node_modules` directory. The clonefile backend requests macOS copy-on-write installation; package directories are never shared symlinks. `bun.lock` is the sole lockfile. Direct dependencies are pinned to the previous compatible resolutions where available. Runtime auto-install is disabled in `bunfig.toml`; missing packages fail instead of changing the dependency graph. The only trusted dependency lifecycle is `node-pty`; esbuild uses its resolved platform binary without running its blocked installation script.

`src/sqlite.ts` owns the synchronous database boundary using Bun's `node:sqlite` implementation. Domain SQL and migrations stay in their existing modules. Connections reject URI filenames and apply the shared production-database test guard. Statements retain blob bytes and exact integers; safe integers become Numbers and larger integers remain BigInts. Unsafe Number bindings are refused. The parameter lexer scans the native consumed SQL once to validate every invocation. Explicit NULL is allowed; missing or undefined required values, ambiguous names and duplicate supplies fail before execution. Unused fields in a named binding object are ignored, preserving domain objects already used by callers. Sparse numbered positional bindings use explicit NULL padding; named numbered bindings can address their slot directly.

Transactions preserve deferred, immediate and exclusive modes, nested savepoints, callback return values and rollback. Callbacks must be synchronous. Retained migration functions remain registered; no schema migration is needed for this driver change. SQLite error numbers are classified once at the boundary.

Arbitrary ledger queries use a separate read-only connection with query-only enabled. SQLite authorization refuses writes, schema changes, attach/detach, transaction controls, user PRAGMA and unsafe functions. The native parser identifies the consumed statement and rejects an executable tail. Row metadata is required, duplicate columns retain their order, and truncation is reported. FTS5's internal data-version read is allowed only while stepping an already-authorized query.

Online backup uses SQLite backup in a separate Bun process. The child finalizes a self-contained snapshot in DELETE journal mode, then publishes it without overwriting an existing destination. Failure and cancellation remove only owned staging files. Live production database files and processes are not replaced by this foundation.

## Local verification

The original macOS arm64 Bun 1.4.2 baseline reported SQLite 3.54.0. Its mmap setting applied a 1 GiB cap, below the requested tuning budget; tuning checks therefore verify the applied budget rather than assuming the previous driver's compile limit.

Two private frozen installs produced identical lock bytes and distinct package-file inodes; editing one installed file did not change the other. Clonefile installation was requested explicitly. The inspected package file had 9,042 logical bytes and 24 allocated 512-byte blocks in each checkout; these per-file statistics do not quantify physically shared extents. A third clean frozen install succeeded with no Node executable on PATH, and esbuild transformed TypeScript under Bun.

Focused evidence covers strict bindings, integer/blob preservation, immediate-lock contention, nested and outer rollback, async refusal, live WAL reads, FTS/JSON queries, parsed query refusals, ordered duplicate columns, asynchronous backup, cancellation, existing-destination preservation, fresh schema, retained-floor upgrades, artifact custody and failed-migration consistency. Source typechecking and emitted database startup passed under the pinned runtime. The integration owner runs the combined build, suites and exact-candidate production daemon/packaged-desktop gate after all lanes stabilize.

The exact candidate passes 39 schema, migration, hardening and auth cases; eight binding, transaction, read-only, FTS and backup cases; and a close regression that retains statement wrappers and an active iterator while confirming no database, WAL or SHM handles remain open. Closed statements and iterators refuse further use, and repeated close safely rejects. The close regression fails on released Bun 1.4.2 without relying on garbage collection. The earliest upstream patch binary proved the close mechanism but crashed the boundary corpus; the selected candidate includes the later virtual-table ownership and callback-root fixes.

Cold-cache offline installation succeeded with the network command blocked and the daemon endpoint unavailable. Corrupt archive and executable inputs were rejected before execution. A Node-free frozen install preserved the existing lockfile. The parent owns the full acceptance suite, real preview cleanup, production daemon and packaged desktop gate, and protected delivery.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

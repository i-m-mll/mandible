# Bun execution and SQLite foundation

Mandible uses Bun 1.4.2 for dependency management and JavaScript execution. `.bun-version` is the runtime pin; `package.json` declares the same exact package-manager and engine version. `scripts/bun-runtime.sh` selects a cached executable or provisions a checksum-verified release without changing the user's ambient installation. `MANDIBLE_RUNTIME` may select another executable only if it reports the pinned version.

For a clean checkout or worktree:

```sh
runtime=$(scripts/bun-runtime.sh)
PATH="$(dirname "$runtime"):$PATH" "$runtime" install --frozen-lockfile --backend clonefile
PATH="$(dirname "$runtime"):$PATH" "$runtime" run --bun build
```

Each checkout owns a real `node_modules` directory. The clonefile backend requests macOS copy-on-write installation; package directories are never shared symlinks. `bun.lock` is the sole lockfile. Direct dependencies are pinned to the previous compatible resolutions where available. Runtime auto-install is disabled in `bunfig.toml`; missing packages fail instead of changing the dependency graph. The only trusted dependency lifecycle is `node-pty`; esbuild uses its resolved platform binary without running its blocked installation script.

`src/sqlite.ts` owns the synchronous database boundary using Bun's `node:sqlite` implementation. Domain SQL and migrations stay in their existing modules. Connections reject URI filenames and apply the shared production-database test guard. Statements retain blob bytes and exact integers; safe integers become Numbers and larger integers remain BigInts. Unsafe Number bindings are refused. The parameter lexer scans the native consumed SQL once to validate every invocation. Explicit NULL is allowed; omissions, undefined, unknown names and duplicate supplies fail before execution. Sparse numbered positional bindings use explicit NULL padding; named numbered bindings can address their slot directly.

Transactions preserve deferred, immediate and exclusive modes, nested savepoints, callback return values and rollback. Callbacks must be synchronous. Retained migration functions remain registered; no schema migration is needed for this driver change. SQLite error numbers are classified once at the boundary.

Arbitrary ledger queries use a separate read-only connection with query-only enabled. SQLite authorization refuses writes, schema changes, attach/detach, transaction controls, user PRAGMA and unsafe functions. The native parser identifies the consumed statement and rejects an executable tail. Row metadata is required, duplicate columns retain their order, and truncation is reported. FTS5's internal data-version read is allowed only while stepping an already-authorized query.

Online backup uses SQLite backup in a separate Bun process. The child finalizes a self-contained snapshot in DELETE journal mode, then publishes it without overwriting an existing destination. Failure and cancellation remove only owned staging files. Live production database files and processes are not replaced by this foundation.

## Local verification

On macOS arm64, pinned Bun reported SQLite 3.54.0. Its mmap setting applied a 1 GiB cap, below the requested tuning budget; tuning checks therefore verify the applied budget rather than assuming the previous driver's compile limit.

Two private frozen installs produced identical lock bytes and distinct package-file inodes; editing one installed file did not change the other. Clonefile installation was requested explicitly. The inspected package file had 9,042 logical bytes and 24 allocated 512-byte blocks in each checkout; these per-file statistics do not quantify physically shared extents. A third clean frozen install succeeded with no Node executable on PATH, and esbuild transformed TypeScript under Bun.

Focused evidence covers strict bindings, integer/blob preservation, immediate-lock contention, nested and outer rollback, async refusal, live WAL reads, FTS/JSON queries, parsed query refusals, ordered duplicate columns, asynchronous backup, cancellation, existing-destination preservation, fresh schema, retained-floor upgrades, artifact custody and failed-migration consistency. Source typechecking and emitted database startup passed under the pinned runtime. The integration owner runs the combined build, suites and exact-candidate production daemon/packaged-desktop gate after all lanes stabilize.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

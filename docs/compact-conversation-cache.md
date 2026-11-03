# Compact conversation cache

The cache is a derived SQLite/WAL index of provider-native transcripts. Native logs remain authoritative; the ledger owns source versions, position spaces and availability. The current physical format is v20. This changes no ledger schema, source identity, user setting or position-space identity.

## Stored facts

The cache stores source coordinates and typed facts needed to plan a conversation without hydrating every body. It does not store renderer objects or transcript copies.

| Purpose | Stored facts |
| --- | --- |
| Generation ownership | Exact conversation/source version, parser and normalization epochs, provider/native session scope, row counts and ready state. |
| Source lookup | Ordered block positions, role/type/parent, native byte locations, native identity components and unchanged 32-byte revision digests. |
| Activity presentation | Typed activity/status/detail flags, operation observations, execution/continuation provenance, forwarding ownership and disclosure recipes. Headers and icons are derived at the consuming boundary. |
| Operation targets | Ordered typed thread, pending-thread and parent-scoped subagent identities with authored label hints. Canonical titles and navigation resolve separately from ledger metadata. |
| Result ownership | Tool-result aliases and operation attribution, including explicit opaque results when a wrapper transforms its output. |

Variable collections use owned child tables. Long messages, commands, scripts and results stay in native logs and are acquired for requested bodies. Small composite numeric keys use WITHOUT ROWID tables; variable-length values use rowid storage to avoid large-key overflow. Shared schema and copy helpers own table inventory, generation closure and selective preview projection.

One normalized observation drives compact, grouped, live and hydrated presentation. Hydration supplies bodies without changing the operation's identity or consuming its first disclosure click. Late tool receipts and live overlays reconcile through the same observation contract.

## Publication and acquisition

A generation becomes readable only when its header and owned rows commit with a ready marker. Incomplete or unreferenced generations are disposable. The cache commits before the guarded ledger source-pointer update; the two WAL databases do not share a transaction.

Selected conversation preparation uses the existing serialized ingestion owner to rebuild the exact required generation from native logs. It does not publish an empty conversation while preparing. Normal appends reuse their proven prefix and update affected owners when results arrive later. Complete plans and bounded reads use the same facts and identity constructors.

Preview extraction takes a consistent read snapshot and copies only compatible generations matching the projected ledger, with required owned-row closure. It writes a bounded private staging file and atomically publishes it after validation. A compatible existing private cache is retained. There is no copy-the-entire-cache step.

## Incompatible caches and retirement

Formats v18 and v19 cannot supply the enriched observation and provider facts required by v20. The runtime reads and writes v20 only; it does not convert coarse historical display facts into apparently complete new observations. The converter and its ingestion-owned preparation path are removed. Existing v1 conversion receipts remain readable for historical validation, but no new conversion receipts are published.

The existing runtime-handoff cleanup owner may invalidate and retire only the exact ledger-owned v18/v19 files and their recognized sidecars. It first qualifies the accepted runtime receipt, current runtime generation, database and installation, fresh process identities, verified old-process drain and absence of open consumers of the obsolete files. Historical acceptance alone does not prove a current healthy runtime.

Cleanup records an atomic v2 invalidation receipt bound to exact paths, formats and file identities. It revalidates the decision, observation lease, current processes and each obsolete file before unlinking. Interrupted removal resumes from the journal-bound decision. Changed identities, unknown schemas and live consumers defer removal; ownership loss aborts. Runtime readiness can trigger the existing cleanup retry. Independent handoff obligations continue when cache retirement is pending.

This is approved runtime-transition behavior. Tests use private fixtures. Exceptional live ledger repairs still require a fresh consistent full online backup; this transition does not repair or rewrite the ledger or native source files.

## Evidence and acceptance

The [v19 transition measurement](cache-transition-evidence.md) records the historical matched-corpus reduction from 4,234,711,040 to 813,387,776 main-file bytes. It is not a v20 size measurement. V20 retains the typed storage design and adds the bounded operation/provider facts above.

Sparse checks cover publication completeness, exact source identity and result ownership, append/late-result reconciliation, selective projection, unknown-schema and changed-file refusal, live-reader deferral and trusted-runtime retirement qualification. Browser acceptance covers cold historical disclosure, ongoing-to-terminal updates, target navigation and scroll continuity. Tests do not pin header copy, icons or component shape.

Co-Authored-By: Codex (GPT) <codex@openai.com>

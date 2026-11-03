# Compact semantic fact cost

The bounded comparison in [issue:673c86b] uses the pinned Bun 1.4.3 and the actual v19 SQLite writer, schema, readers and shared presentation functions. [Raw measurements](evidence/compact-index-cost.json) retain three fixed repeats of 500 invocations per input. Reproduce with `scripts/bun-runtime.sh --exec scripts/compact-index-cost.ts`; all files are private temporary fixtures, removed on completion. These are local warm filesystem measurements, not a cold-disk claim or a timing-sensitive test.

| Input | Source bytes | Derive with input available, µs | Acquire JSON + derive, µs | Read packed semantic facts, µs | Derive from available compact facts, µs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct command | 127 | 0.92 | 12.88 | 5.71 | 0.10 |
| Nested wrapper | 247 | 19.35 | 33.47 | 5.02 | 0.04 |
| Reasoning detail | 2,885 | 1.30 | 14.41 | 4.46 | 0.07 |
| Inline directives | 277 | 8.77 | 23.65 | 4.51 | 0.02 |

The available-input column includes command-field selection for the direct tool and Acorn-backed program inspection for the wrapper. The acquisition column adds a real file read and JSON decoding before the same functions; it does not include provider transcript normalization. The packed-read column reads scalar flags, execution kind/count and typed operation/step rows from the actual format, including native SQLite value decoding. The compact-derivation column reconstructs shared operation labels from categories and counts or reads the already available bitset. Whole single-generation index reads, including scope/identity/disclosure decoding and dependency hashing, are reported separately in the raw packet; charging that entire navigation cost to one persisted flag would misattribute work needed in either representation.

Persist the execution projection that avoids another wrapper parse, source-dependent visibility/detail/summary flags, and source fragment/directive boundaries. Derive operation vectors from the stored native name, tool kind and execution facts whenever the result is exactly equal to the full projection. Retain typed child operation facts only when they differ, such as wrappers containing different operation categories. Static phrases/icons, empty bodies, renderer provenance and canonical compound key strings are reconstructed. No authored summary or command/script body enters the cache. Source-dependent summary text remains an on-demand source dependency.

The actual 128-source-row mixed fixture took 5.10 ms to index and 5.81 ms to publish. Complete read/decode/manifest/plan took 3.70 ms at the median; bounded acquisition of all 128 positions took 11.92 ms. The append reused that prefix and published one additional nested-wrapper row in 3.00 ms after 0.24 ms indexing. Complete planning reuses one in-memory manifest for the current publication, and bounded acquisition reuses those facts while hydrating bodies only for the rows or summaries that require them. The four individual cases plus the 128-row generation and its append occupied 245,760 database bytes with 109,790 dbstat payload bytes, including source coordinates, native identities, revisions, indexes and both retained generations. This tiny fixture is page-allocation dominated; the transition lane supplies the matched full-corpus storage comparison.

Co-Authored-By: Codex (GPT) <codex@openai.com>

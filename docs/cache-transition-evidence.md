# Historical v19 cache transition evidence

This records the accepted v19 implementation and its private qualification corpus. The current v20 runtime uses selected native-source rebuilding and receipt-bound invalidation instead of this converter; see [the current cache contract](compact-conversation-cache.md). These measurements remain evidence for the v19 candidate only.

[issue:44569c8] implemented the v18→v19 transition for [issue:fc18cb7]. The measured storage implementation is `b602c464`; conversion code is `9300cd78`. The pinned Bun selector qualified candidate `900eae300`. [Raw measurements](evidence/cache-transition-corpus.json) retain table allocation/payload/overflow/unused counts and the exact corpus digest; the [semantic cohort](evidence/cache-transition-cohort.json) contains only counts, tuple digests and equality results.

One read-only `src/sqlite.ts` connection held a WAL snapshot throughout conversion and comparison. Every compatible v18 generation in that snapshot was converted through the production generation writer into a private cache. A private measurement ledger selected each exact old tuple in turn, including retained prior versions; production ledger pointers and caches were never changed. No transcript reparse, full-cache backup or VACUUM was used.

| Measurement | Result |
| --- | ---: |
| Exact generations | 10,246 |
| Source blocks | 2,269,442 |
| Conversion and comparison time | 171.06 s |
| Old main file | 4,234,711,040 bytes |
| Old WAL / SHM at snapshot | 16,298,752 / 32,768 bytes |
| New main file | 813,387,776 bytes |
| New WAL / SHM at observation | 0 / 32,768 bytes |
| Main-file reduction | 80.79% |
| Peak temporary new-cache bytes | 817,240,088 bytes |
| Conservative input + output peak bound | 5,068,282,648 bytes |
| Old / new overflow pages in bytes | 2,346,950,656 / 0 |
| Old / new payload bytes | 2,028,748,752 / 678,344,345 |
| Old / new unused page bytes | 2,164,516,014 / 49,656,788 |

File allocation matched logical size for both main files. The old WAL used 16,302,080 allocated bytes. The combined peak is the sum of separately observed input and output maxima; it is a conservative bound rather than a claim that those maxima occurred in the same sample. Temporary output measures the new cache and its WAL/SHM; the private measurement ledger is fixture scaffolding, not a runtime migration artifact.

All 12 deterministic cohorts (the three largest generations plus evenly spaced generations) matched complete position facts, source/member/run coordinates, disclosure identities, summary/detail flags and tool-result aliases. The three largest contain 26,343, 19,754 and 18,403 blocks. Conversion also applied the shared lossless native-identity recipe decoder to the entire corpus. The final cache passed `quick_check`; `foreign_key_check` returned no violations. This is structural/presentation equivalence evidence; source-body hydration and browser/native behavior remain integrated acceptance checks.

Focused checks cover interrupted retry and ready-only visibility, selected conversion taking over paused background work, stale conversion rejection after a new source pointer, exact selective projection, isolated pre-transition v18 preview seeding, coverage wake, receipt mismatch refusal, live-reader deferral, interrupted unlink after removal of the old main file, and idempotent cleanup retry. Forty-four related conversion/readiness/handoff/scheduling/demand cases passed, as did typechecking. The strengthened unlink regression passed subsequently in the 11-case handoff file.

The first 60-second measurement stopped safely with an incomplete private cache. Hoisting repeated statement preparation improved the observed prefix from 507,237 blocks in 59.4 s to 570,615 blocks in 38.8 s. A second partial run was cancelled when the final operation-fact elision changed the measurement inputs. Both obsolete private outputs were removed. The final run used the frozen storage inputs and a bounded 480-second command timeout authorized for this full-corpus evidence.

The final private v19 file was used for selective long-chat preview extraction and removed after qualification; the measurements are retained. Production conversion and obsolete-file retirement were not executed during this measurement. The measured v19 candidate qualified conversion coverage and retirement through the existing handoff helper. Current v20 invalidation has its separate current-runtime and exact-file qualification described in the cache contract.

Co-Authored-By: Codex (GPT) <codex@openai.com>

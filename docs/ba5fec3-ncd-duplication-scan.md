# Alpha-normalized NCD duplication scan

Mandible-Issue: ba5fec3

## Predictions, published before the first run

These were written and committed before the scanner had been run over the tree.
Outcomes are recorded beside them further down, whichever way they fell.

- **P1 — unit count.** At `minTokens=40` over the tracked TypeScript/TSX tree
  (~305k lines, 746 files), extraction yields between 6,000 and 9,000
  comparable units.
- **P2 — runtime.** A full scan — parse, normalize, shingle, MinHash, LSH,
  Jaccard, NCD, render — completes in under 120 s in a single process on this
  machine, which is under contention from other agent sessions.
- **P3 — top-of-list composition.** Of the top 50 retained pairs by NCD, at
  least 60 % are either in test files, covered by a binding rejection in
  `docs/88e6aeb-post-consolidation-design-review.md`, or ordinary boilerplate
  (row mappers, CLI argument parsing, event envelopes). At most 5 are genuinely
  novel unification candidates that the design review did not already consider.
- **P4 — disagreement with `jscpd`.** `jscpd` matches token sequences after
  light normalization and reports contiguous clone regions; this scanner
  compares whole declarations after alpha-renaming. Fewer than 25 % of the file
  pairs in this scanner's top 50 also appear as `jscpd` clone pairs.

## What the scanner is

`scripts/ncd-scan.mjs`, configured by `scripts/ncd-scan.config.json`.

Normalized Compression Distance over alpha-normalized declarations:

    NCD(x, y) = (C(xy) - min(C(x), C(y))) / max(C(x), C(y))

Lower is more similar. The pipeline is:

1. **Extract.** The TypeScript compiler API parses each tracked source file.
   Comparable units are function-like declarations (function declarations,
   methods, constructors, arrows and function expressions), type declarations
   (interfaces and type aliases), and string or template literals that look
   like SQL.
2. **Normalize.** Each unit is serialized as a preorder token stream of AST node
   kinds plus leaf tokens. Identifiers bound inside the unit — parameters,
   locals, nested function and class names, type parameters, catch variables,
   destructured bindings — are alpha-renamed to `$0`, `$1`, … in order of first
   appearance. Free identifiers are preserved verbatim, because a call target,
   an imported name, a property name, or a type name is shared structure rather
   than a locally arbitrary choice. String, numeric, regex and template literal
   payloads are erased by default (`--literals keep` retains them). Comments and
   all formatting are absent by construction, since the stream is built from the
   AST rather than from source text.
3. **Prefilter.** Token 5-shingles, an exact prefix filter over shingles
   ordered by global document frequency, then exact Jaccard on the surviving
   candidates. NCD is never computed for the full quadratic pair space. The
   prefix filter has no false negatives: any pair at or above the Jaccard
   threshold is guaranteed to be produced as a candidate.
4. **Score.** `zlib.deflateRaw` at a fixed level, memory level and window size,
   so the compressor is deterministic. NCD is computed in both concatenation
   orders and the minimum is reported; the asymmetry between the two is carried
   in the output as a diagnostic.
5. **Report.** Ranked JSON and Markdown with paired file, line range, unit name,
   kind, token count, compressed size, tags, and the first tokens of each
   normalized unit, so a pair can be triaged without opening both files.

## Explicit limits

The output is an attention list, not a proof of semantic equivalence.

- A low NCD says two declarations carry overlapping structural information. It
  says nothing about whether they may share an implementation. Transaction
  boundaries, ordering guarantees, query shape, scroll ownership and authority
  boundaries are invisible to the compressor and are exactly what decides
  whether a unification is sound.
- Tests, fixtures, generated files, snapshots and vendored code are tagged and
  their pairs are moved out of the primary ranked list. They are still printed
  in a separate section, so an exclusion can be audited rather than trusted.
- Pairs covered by a binding rejection in
  `docs/88e6aeb-post-consolidation-design-review.md` are annotated in place.
  Annotation never removes a pair; it marks the pair as settled so that a
  reviewer does not re-litigate a decision that was made on semantic grounds.
- `zlib`'s sliding window is 32 KiB. A unit larger than that cannot be fully
  referenced from the second half of a concatenation, so NCD understates the
  similarity of very large pairs. Such pairs are flagged `windowLimited` rather
  than silently mis-scored.


## Further predictions, published before the corresponding measurement

- **P5 — literal erasure and SVG icons.** The default normalization erases string
  literal payloads, so a family of SVG icon components that differ only in their
  `d` path data normalizes to the same token stream. Re-running with
  `--literals keep` will remove the icon families from the top of the ranked
  list and cut the total retained pair count by more than 40 %.
- **P6 — canonical JSON.** The four independent canonical/stable JSON
  serializers are not all equivalent: at least one differs from the others in
  its treatment of arrays, `undefined`, or nested objects, so they can produce
  different digest inputs for the same value.
- **P7 — `jscpd` default size cap.** `jscpd` reported 425 files analyzed while
  the NCD scanner covered 762, and 10 tracked files in `jscpd`'s own scan roots
  exceed its 100 kB default `--max-size`. Re-running with `--max-size 10mb` will
  raise both the analyzed-file count and the clone count by more than 20 %.
- **P8 — `jscpd` default line cap.** P7 was wrong; lifting `--max-size` added one
  file. `src/auth-queue.ts` (6,900 lines) is still absent from the analyzed set,
  which points at `jscpd`'s `--max-lines` default of 1000 rather than its size
  cap. Re-running with `--max-lines 100000 --max-size 10mb` will raise the
  analyzed file count above 400 and more than double the clone count (173 to
  over 346).
- **P9 — effect of the unifications.** Removing 5 canonical-JSON copies, 14 JSON
  column parsers, 7 route body guards, 4 backend `extractModel` copies and 2 UI
  write wrappers eliminates whole clone families rather than single pairs.
  Re-running the scan will cut retained non-dropped pairs from 1,631 to between
  1,450 and 1,530.

## Prediction outcomes

| | Prediction | Outcome |
| --- | --- | --- |
| P1 | 6,000–9,000 units | **Wrong.** 12,092 units, 34 % above the top of the range. The estimate was made per file; nested arrows and methods are extracted as units in their own right and dominate the count. |
| P2 | Under 120 s | **Right, by a margin large enough to be its own finding.** 3.0 s for the first full scan and 4.3 s once the prefilter became exact. The prediction was 40× too pessimistic, and that slack is what made the exact prefix filter affordable. |
| P3 | ≥60 % of the top 50 are tests, binding-rejection regions or boilerplate; ≤5 novel candidates | **Right on the first clause, wrong on the second.** Test-tagged pairs were routed out of the primary list entirely (5,454 of 7,085 retained pairs), and the surviving top 50 was dominated by region-annotated and boilerplate pairs. But it contained more than five actionable families, not fewer: canonical JSON, the JSON column parsers, `bodyRecord`, `extractModel`, the UI write wrappers, `isSqliteBusy`, `tableHasColumn`, `runGit`, `objectAt`, `settingsGet`. |
| P4 | <25 % overlap with `jscpd` | **Wrong.** Measured at file-pair level, 50 % of the top-50 file pairs also appear as `jscpd` clone pairs. Under the stricter test — does one `jscpd` clone actually cover both declarations — the figure is 38 %, still above the predicted ceiling. |
| P5 | `--literals keep` removes icon families from the top and cuts retained pairs >40 % | **Right on the count, half wrong on the mechanism.** Retained pairs fell 7,085 to 4,152, a 41.4 % cut. Icon pairs fell from 66 to 4 across the whole kept list, but 3 of 4 survived *in the top 50* — those are genuinely duplicate icon components, not normalization artifacts. |
| P6 | At least one canonical-JSON copy differs | **Wrong, then right, for an instructive reason.** The four copies the scanner ranked are exactly equivalent, so on the scanner's own output the prediction was falsified. Grepping the removed names found two further copies the scanner never ranked, and one of those — `stableJson` in `provider-artifacts.ts` — does differ. The scanner's recall gap hid the only divergent implementation in the family. |
| P7 | Lifting `jscpd --max-size` raises files and clones >20 % | **Wrong.** It added one file, 938 lines and zero clones. The prediction rested on differencing two counts that measure different things — the scanner's 762 whole-repo files against `jscpd`'s 425 files over five subdirectories. |
| P8 | Lifting `jscpd --max-lines` raises files above 400 and more than doubles clones | **Right.** 425 to 484 files, 173 to 421 clones, 104,883 to 214,765 lines. |
| P9 | Post-unification retained pairs land in 1,450–1,530 | **Wrong, by three.** 1,447. The unifications removed slightly more than predicted. |

Four of nine predictions held. The two that mattered most were P7 and P8: P7 was
the exact error this work is prone to — differencing two correctly measured
numbers that count different populations — and chasing its failure is what
found P8.

## What the two tools disagree about, and why

Both tools were pointed at the same five directories with comparable minimums
(`jscpd --min-tokens 50 --min-lines 5`; this scanner `minTokens 40`,
`jaccardMin 0.35`).

**`jscpd` skips large files by default, and does not say so.** Its `--max-lines`
default of 1000 excluded `src/auth-queue.ts` (6,900 lines),
`src/provider-artifacts.ts`, `src/ledger/store.ts`, `src/ingestion.ts`,
`ui/src/app.tsx` and `ui/src/api.ts` — that is, every module a leanness pass
most wants examined. Lifting the cap doubled the analyzed corpus (104,883 to
214,765 lines) and found 2.4 times the clones (173 to 421).

The headline percentage barely moved: 2.25 % to 2.35 %. A ratio computed over a
corpus that silently excludes half the code stays stable while the absolute
finding count more than doubles. Anyone reading "1.85 % duplicated" from a
default `jscpd` run in this repo is reading a number computed over the half of
the tree that was small enough to be scanned.

**Where they agree.** 38 % of this scanner's retained pairs have a `jscpd` clone
covering both declarations. These are the verbatim copy-paste families:
`parseJsonObject`, `bodyRecord`, `extractModel`.

**What `jscpd` finds and this scanner does not** — 52 % of `jscpd`'s file pairs
have no NCD pair at all. `jscpd` matches contiguous token runs wherever they
occur, including fragments that straddle declaration boundaries, repeated blocks
inside one long function, and long literal or configuration tables. This scanner
only ever compares whole declarations, so a duplicated 60-line stretch spanning
the tail of one function and the head of the next is invisible to it.

**What this scanner finds and `jscpd` does not.** Alpha-renamed variants.
`jscpd`'s default mode normalizes formatting and comments but not identifiers,
so `canonical` / `canonicalJson` / `stableJson` are three different token
sequences to it, while their normalized streams here are identical (Jaccard
1.00, NCD 0.051). Every unification in this change except `bodyRecord` and
`extractModel` was found this way.

The two measure different things and the right reading is the union, not either
number alone.

## What was found

12,065 units over 765 tracked files; 6,901 pairs at or below NCD 0.55 with
Jaccard at or above 0.35; 5,454 of those routed out of the primary list because
at least one side is test, fixture, generated, snapshot or vendored code.
Grouping the primary list into connected components at NCD 0.20 or below gave
216 families over 499 declarations.

### Unified

| Family | Sites | Where it went |
| --- | ---: | --- |
| Canonical JSON for digest inputs | 5 of 6 | new `src/canonical-json.ts` |
| JSON column parsers | 14 of 15 | existing `src/row-coerce.ts` |
| Route body guard | 7 of 8 | existing `src/routes/http.ts` |
| Backend `extractModel` | 4 of 4 | new `src/backends/cli-args.ts` |
| UI JSON write wrappers | 3 of 3 | one `apiWrite` in `ui/src/api.ts` |

Net effect across the five changes: 181 lines added, 340 removed, and the 72
pairs naming any of these helpers fell to zero.

Two of the five needed no new abstraction at all. `src/row-coerce.ts` already
existed and already owned the sibling coercions; `src/routes/http.ts` already
existed and was already imported by all seven route files that re-declared
`bodyRecord` beside the import. That is the most useful shape of finding here:
the shared module was present and the duplicates were bypassing it.

### Deliberately not unified

- **`stableJson` in `src/provider-artifacts.ts`.** Sorts keys with
  `localeCompare` rather than the default code-unit order, so it already emits
  different bytes from the other five, and it feeds `hashBuffer` for
  content-addressed artifact ids. `localeCompare` without an explicit locale
  follows the host locale: `sv-SE` orders `ä` after `z` where `en-US` orders it
  after `a`, so the same artifact JSON can address differently on different
  machines. Changing it changes existing ids. This needs an identity decision,
  not a refactor.
- **`parseInput` in `ui/src/components/message-blocks/ToolUseBlock.tsx`.**
  Returns a non-string input unchanged, and its only caller passes an
  already-parsed object. Replacing it with the string-only shape would parse
  `"[object Object]"`, fail, and silently discard every rendered tool argument.
- **`bodyRecord` in `src/routes/conversation-custody.ts`.** Delegates to
  `readBody`, which casts whatever arrived, so an array body passes through
  rather than becoming an empty record. Aligning it is a behavior decision about
  malformed request handling.
- **`addWsClient` and `sendPrompt` across the backends.** `addWsClient` is
  about 38 lines repeated three times and differs in one live respect: the SDK
  backend early-returns on a `resize` frame that the other two forward to
  `write`. `sendPrompt` is byte-identical across three but reads and writes
  per-instance queue state and sits beside `processPromptQueue`, which is
  genuinely different per backend. Both are daemon runtime paths that need a
  behavior decision first.
- **`queryString` in `src/routes/spaces.ts` and `src/routes/providers.ts`.**
  Scored as an exact structural pair, and `src/routes/http.ts` already exports a
  `queryString` — but the shared one takes the first element of an array value
  and does not trim, while the local one trims and treats a blank value as
  absent. Three different readings of `?key=` now exist. This is a finding, not
  a merge.
- **`handleError`, 13 copies across route modules.** Structurally similar and
  semantically distinct: each maps its own domain error types to status codes.
- **Everything covered by a binding rejection.** `getIssue` / `getEvent` /
  `getComment` / `getIssueCheckpoint` in `src/ledger/store.ts`,
  `getSpaceBlock` / `getSpaceItem` / `getSpaceEdge` / `getSpaceOccurrence`, and
  the `provider-artifacts.ts` getter family all scored as tight families. They
  are exactly the generic `Repository<T>` and reflective `fromRow<T>` that
  `docs/88e6aeb-post-consolidation-design-review.md` rejected on semantic
  grounds. The scanner ranking them is the scanner working; the rejection stands.

### The scanner cannot support reopening R6

`src/auth-queue.ts` was singled out for a reopened recovery-service extraction
because it grew to roughly 6,900 lines. Neither tool finds duplication there.
This scanner returns four pairs touching the file — `tailLines` shared with
`src/routes/auth.ts`, two SQL templates, and `retry` / `requeue` at NCD 0.126.
`jscpd`, once its line cap is lifted so it can see the file at all, reports four
clones totalling 40 duplicated lines out of 6,900, about 0.6 %.

Whatever the case for extracting a recovery service is, it is not a duplication
case. The design review's own standard applies: "File size and state-hook count
are discovery signals, not acceptance criteria." A duplication scanner is the
wrong instrument for a cohesion argument, and this is recorded as declining to
support the reopening rather than as silent absence of evidence.

## Limits found by using the tool

- **Whole-declaration comparison misses cross-boundary clones.** 52 % of
  `jscpd`'s file pairs have no counterpart here.
- **Recall depends on statement order.** The canonical-JSON family is the worked
  example: two copies that reorder the null and array guards fell below the
  Jaccard floor and were never ranked, and one of those two was the only
  divergent implementation in the family. Grep on the removed names found them;
  the scanner did not.
- **Literal erasure creates a false-positive class.** SVG icon components that
  differ only in path data normalize identically. `--literals keep` separates
  them, at the cost of missing renamed-constant variants. Neither setting is
  correct for every question, which is why both are supported.
- **Path-based binding-rejection annotation over-marks.** `bodyRecord` in seven
  route files is annotated R3, but R3 rejected a handler DSL, not a shared
  four-line body guard. The annotation says "this pair sits in a region where a
  large abstraction was rejected", which is a prompt to check, not a verdict.
- **An exact prefix filter beat the approximate one and is simpler.** The first
  implementation used MinHash with LSH banding at 32 bands of 4 rows. Measured
  against the exact filter it found 5,650 of 7,093 qualifying pairs — 79.7 %,
  silently. A closed-form recall estimate at the threshold predicted far worse,
  about 38 %; that estimate assumed a uniform Jaccard distribution, whereas the
  real one is concentrated near 1.0. Replacing MinHash and LSH with a prefix
  filter removed about 50 lines, removed the recall question, and cost 0.8 s.

## Incidental findings

- `src/credential-leak-scan.ts` contains three literal NUL bytes, used as field
  separators inside template literals for a hash input and a composite map key.
  They are deliberate and the file is valid UTF-8, but `file(1)` reports it as
  `data` and plain `grep` silently skips the whole file. Writing them as
  `\u0000` escapes would be behavior-preserving.
- The default test suite is load-sensitive rather than flaky in content. Three
  full runs during this work, at load averages between 50 and 86, produced 1, 2
  and 7 failures with disjoint membership; every failing file passed when re-run
  in isolation, and a final full run at load average 26 was green across all 86
  files and 1,534 tests. The failures are daemon-spawn and health-probe
  timeouts.
- A worktree with no `dist/` fails four daemon-boot tests for that reason alone.
  `npm run build` in the worktree is a precondition for a meaningful run.

## Reproducing

```bash
npm run scan:duplication -- --root . --out report --top 200
npm run scan:duplication -- --root . --literals keep --out report-literal
npx --yes jscpd@4.0.5 src ui/src scripts cli channel-server \
  --min-tokens 50 --min-lines 5 --max-size 10mb --max-lines 100000 \
  --reporters json --output jscpd-out \
  --format "typescript,tsx,javascript,jsx" \
  --ignore "**/dist/**,**/node_modules/**,**/*.d.ts"
```

`jscpd` is invoked through `npx` at a pinned version rather than added as a
devDependency: it is a one-off comparison instrument, not part of the delivered
tooling. The `--max-size` and `--max-lines` overrides are not optional in this
repo — without them `jscpd` reports on roughly half the code and says nothing
about the omission.

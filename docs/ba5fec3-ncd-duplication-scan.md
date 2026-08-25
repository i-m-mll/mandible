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
3. **Prefilter.** Token 5-shingles, MinHash signatures over a fixed seed set,
   LSH banding, then exact Jaccard on the surviving candidates. NCD is never
   computed for the full quadratic pair space.
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

## Results

_Recorded after the run; see below._

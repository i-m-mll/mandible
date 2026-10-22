# `test/quarantine/` — red, issue-backed

`bun run test:quarantine`

**This suite is expected to fail.** Every file here holds `it()` blocks
extracted verbatim from a test elsewhere in the tree, because the assertion is
failing and the defect is real. The rest of each source file stayed where it
was and is green. When every test in a file was red, the file moved here whole.

Before quarantining a red test, decide in this order:

1. **Should the test exist?** Apply the two questions and the fatal list in
   [`test/README.md`](../README.md). A test that pins presentation or restates
   the code is deleted, not quarantined.
2. **Is the fixture wrong?** Fix the fixture; nothing is quarantined.
3. **Is the product wrong?** Then, and only then, the test comes here, naming
   the open issue that owns the fix.

Rules:

- Every file carries a `// Quarantined: <issue> — <one line>` header naming an
  **open** Mandible issue.
- Nothing green is admitted. A quarantine file going green is the signal to fix
  the issue, close it, and move the block back to its home file.
- Nothing is deleted from here to make the suite pass. Fix the defect, or
  delete the test because it should not exist (step 1).

`bun run test` and `bun run test:provisioned` must pass; this suite must not.
That asymmetry is what makes the boundary checkable.

Two failures share one issue when they share one cause.

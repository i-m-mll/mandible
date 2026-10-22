# `test/quarantine/` — red, issue-backed

`npm run test:quarantine`

**This suite is expected to fail.** That is the point. Every file here holds
`it()` blocks extracted verbatim from a test elsewhere in the tree, because the
assertion is failing and the defect is real. The rest of each source file
stayed where it was and is green — quarantining a hundred passing tests to hide
one failure would itself be hiding. When every test in a file was red, the file
moved here whole and nothing was left behind.

Rules:

- Every file carries a `// Quarantined: <issue> — <one line>` header naming an
  **open** Mandible issue.
- Nothing green is admitted. A quarantine file going green is the signal to fix
  the issue, close it, and move the block back to its home file.
- Nothing is deleted from here to make the suite pass. Fix the defect or keep
  the red.

`npm test` and `npm run test:extended` must pass; this suite must not. That
asymmetry is what makes the boundary checkable.

Two failures share one issue when they share one cause; filing one defect
several times makes the ledger, not the code, look busier.

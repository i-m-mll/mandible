# `test/extended/` — green, on demand

`npm run test:extended`

Every file here was moved by one rule, not adjudicated one by one. A file is in
the default gate (`npm test`) only if it is on the whitelist in
[`../README.md`](../README.md); everything else is here. The rules that placed
these files, in order:

| Rule | Count |
| --- | --- |
| Renders Preact (`.tsx`) | 65 |
| Imports `ui/src/…` and never `src/…` | 30 |
| Everything not on the whitelist | 152 |

Two facts hold for every file in this directory, and they are what make the
boundary checkable rather than a promise:

- **It is green.** `npm run test:extended` must pass. Nothing red is admitted
  here — a red test is either deleted with its file or extracted into
  `test/quarantine/` against an open issue.
- **Nothing was moved because it failed.** Classification ran before anyone
  looked at which files were red. A file is here because it is not on a
  whitelisted boundary, never because of its colour.

There are no per-file reasons in this directory, and adding them would recreate
the archaeology the whitelist exists to avoid. Per-file reasons are mandatory
only in `test/quarantine/`.

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

Anything not promoted within 90 days is deleted. Git retains it either way.

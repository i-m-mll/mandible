# Local client access

Mandible is a single-human-user application. Ordinary local access belongs to
the owning operating-system account and does not expire. Provider names and
task IDs describe the actor; they do not prove which executable or model is
running.

## Local tools

The daemon serves its existing router over a Unix socket inside an owner-only
directory. The directory is mode `0700` and the socket is mode `0600`. Startup
refuses unsafe ownership, symbolic links, and an already active listener. A
stale socket may be removed only after verifying its type, ownership, and lack
of a live listener. Shutdown removes only the socket owned by that launch.

The production socket is `~/.cache/mandible/local-api/production.sock`.
`MANDIBLE_SOCKET` selects an explicit absolute socket path. Preview instances
use distinct paths and retain their existing restrictions on effects.

Local CLI calls use this transport automatically. Failure to reach it is a
connection failure, never a reason to silently retry against HTTP. Explicit
HTTP and file-RPC clients retain their existing credential boundaries.

Ordinary socket requests do not read Keychain, inherit bearer authority, or
exchange a durable credential for an expiring session token. An obsolete
`MANDIBLE_TOKEN` in an agent environment does not prevent ordinary local work.

## Attribution and permission

Provider integrations supply the current provider and task ID deterministically.
Clients attach them to requests without asking the model to discover or remember
them. Claimed provider identity resolves only to an active agent account;
ambiguous or missing managed-client identity never becomes the human operator.
The provider task and any Mandible session alias remain distinct identifiers.

The server records local socket access separately from verified credential
evidence. Local access still passes through the existing project permissions,
resource ownership checks, and instance effect limits. A task ID is never an
approval or a transferable credential.

Protected request lifecycle, durable work-unit custody, clearances, credential
administration, and mapped external execution retain their explicit credential
requirements. The client selects the durable credential deliberately for these
routes, before sending the request. It does not retry rejected mutations with
stronger credentials. Existing request and work-unit credential ownership stays
unchanged. This contract does not introduce a new request-signature protocol.

## Browser and preview access

The browser keeps the existing HTTP front door, exact host and origin checks,
and CSRF protection. Both human and agent clicks use the same application
request helper. CSRF checks distinguish permitted browser origins; they do not
distinguish a person from browser automation and are not disabled in previews.

A preview may change its isolated ledger and files. Local transport does not
grant it production writes, protected execution, credential administration, or
other effects excluded by its registered policy.

## Verification

Acceptance covers tokenless local reads and ordinary writes, restart with the
same task identity, stale inherited tokens, unsafe socket paths, active listener
conflicts, and TCP attempts to claim socket access. Protected actions must reject
unverified claims and preserve exact durable credential ownership. Browser
writes must work with CSRF enabled while cross-origin writes remain refused.

The final candidate must pass the repository's default checks and a production
daemon plus packaged desktop launch from that exact revision. Runtime acceptance
includes startup readiness, a representative interaction, and inspection of that
launch's logs for unexplained failures or event-loop stalls.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

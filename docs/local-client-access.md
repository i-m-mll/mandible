# Local client access

Mandible belongs to the logged-in operating-system user. Opening it gives that
user access without login, pairing, renewal, or expiry.

Projects organize this ledger and do not isolate local agents. Project roles,
restriction settings and project grants are retired. Global capability grants
continue to govern concrete effects; canonical project and source identities
remain part of domain operations and approval scope.

The CLI uses an owner-only Unix socket at
`~/.cache/mandible/local-api/production.sock`; `MANDIBLE_SOCKET` selects an
absolute alternative. Connection failure does not fall back to HTTP. Preview
instances have separate sockets and effect limits.

Local agent calls identify the actor by provider and session, or by a managed
app and session before a provider ID is available. Mandible records this as
`session_claim` attribution. Missing or conflicting managed identities are
refused, never treated as the human operator. For Codex, `CODEX_THREAD_ID`
takes precedence over an inherited same-provider `CODEX_SESSION_ID`.

Local socket calls ignore bearer tokens, including inherited `MANDIBLE_TOKEN`.
A session claim is not human proof. Responsibility changes require an explicit
operation with a reason and observed generation or checkpoint; protected
effects require the configured operator's action-bound key proof. Browser
requests retain host, origin, and CSRF checks. Explicit remote or scoped
transports retain their credential boundaries. See
[Architecture](/docs/concepts/architecture).

File-RPC attachments use the existing `attachments.content_path` envelope to
name one published spool basename. The daemon strips client-supplied
`content_path`, `content_buffer`, `precomputed_sha256`, and `cas_materialized`
body fields. Only transport acquisition can create the internal opened source.
The spool root must be a nonsymlink directory owned by the current OS user with
owner-only permissions. Its ancestors are host-owned transport infrastructure;
leaf no-follow acquisition does not provide confinement against replacement of
those ancestors. A sandbox that can replace the root or its ancestors requires
descriptor-relative directory acquisition before it can use this contract.

On supported POSIX runtimes, acquisition requires
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then `fstat` verifies a regular file owned
by the current OS user with one link. The bounded artifact worker borrows that
exact descriptor for reads, hashing and CAS materialization. It never reopens
the published name or a descriptor filesystem path. Stored CAS integrity is
verified in that worker, including when the destination already exists. Only
an in-process result bound to the CAS root and hash authorizes registration
without rereading or hashing full bytes on the daemon thread; JSON flags do not
provide that authority. The transport closes the
descriptor after consumption finishes or the worker terminates. Identity,
length, size and timestamps are checked around reading; publication must remain
immutable after the request becomes visible. A replaced name can yield original
opened bytes or a changed-input refusal, never replacement bytes. This is a
single-user transport boundary, not protection against unrestricted processes
of the same OS user modifying the daemon or arbitrary inodes.

Missing or ineffective required flags and unsupported platforms refuse
attachments without a plain-open retry; attachment-free RPC remains usable.
The macOS arm64 pinned Bun revision `900eae300` has execution evidence for
no-follow refusal, nonblocking FIFO refusal, descriptor borrowing and lifetime
through worker termination. Linux uses the same POSIX acquisition contract but
requires its own execution evidence before runtime support is qualified.

Malformed fields/names, missing files, symlinks, hardlinks and nonregular objects
produce a 400 response with `file_rpc_attachment_invalid` or
`file_rpc_attachment_missing`. Changed bytes produce 409
`file_rpc_attachment_changed`; unavailable safe acquisition produces 501
`file_rpc_attachment_unsupported`; unexpected read, worker and storage failures
produce 500 `file_rpc_attachment_io_error`. Context contains only the attachment
basename. Cleanup unlinks the owned entry and never recursively removes a
substituted directory or follows a symlink. Cleanup failure is logged as
`file_rpc_cleanup_failed` without replacing the terminal response. Denied routes
never acquire or materialize attachments. Stable request IDs, response retention,
timeouts and replay behavior are unchanged. A request-bound terminal receipt is
published before its response and retained until request retirement succeeds.
Later polls and daemon restarts use that exact result without redispatch, even
if the client consumed the response. Response expiry waits for the retained
request to retire; orphan receipts are removed when their request is absent.
Attachments add no byte ceiling;
current consumer limits and bounded worker concurrency continue to apply.

Co-Authored-By: Codex (GPT) <codex@openai.com>

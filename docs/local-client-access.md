# Local client access

Mandible belongs to the logged-in operating-system user. Opening it gives that
user access without login, pairing, renewal, or expiry.

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

Co-Authored-By: Codex (GPT) <codex@openai.com>

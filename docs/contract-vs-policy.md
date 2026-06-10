# Contract vs. Policy

Mandible is deliberately split into two layers. **Contract** is what Mandible
itself defines and enforces: interfaces, invariants, and lifecycle rules that
hold for every install. **Policy** is everything a particular user or team
decides about how they work: signing identities, commit tooling, worktree
conventions, instruction-file content. Mandible recognizes and enriches policy
artifacts where it can, but never requires any particular policy to function.

Keep this distinction intact when adding features: if a behavior must hold for
every Mandible user, it belongs in the contract (daemon, CLI, instructions
fragment); if it encodes one user's working style, it belongs in their
configuration layer (e.g. dotfiles) and Mandible should at most *interoperate*
with it.

## The contract

What Mandible defines, for every install:

- **Ledger as coordination substrate.** Issues, comments, labels, body
  revisions, and relationships are event-sourced in the daemon-owned SQLite
  ledger. The daemon is the single writer; the CLI and dashboard are clients.
  git-bug refs are a compatibility mirror, not the hot path.
- **Auth-request lifecycle.** Protected-branch merges are asynchronous:
  a client submits a request (`mandible auth request`), the user approves in
  the dashboard or terminal, and `auth merge` executes it. Approval is a user
  action in Mandible's UI — it does not depend on any external credential
  system.
- **Trailer linkage (optional).** Commits may carry `Mandible-Issue: <ref>`
  trailers. Mandible parses them to link commits, sessions, and work units to
  issues. Trailers are an *interface format*, not a requirement: commits
  without them are fully valid and simply unlinked.
- **Work units and sessions.** Dispatch state (open → committed → resolved)
  joins issues, branches, and agent sessions. Registration hooks (`.issue`
  files, session APIs) are optional enrichment with graceful absence.
- **Artifact registry.** `mandible artifact` records repo- or
  custody-backed artifacts with explicit recoverability semantics.
- **Coordination primitives.** Issue head digests (`issue heads`,
  `issue changed --since-manifest`), `worker_status`, issue–branch relations,
  and delegation manifests support the umbrella-as-coordinator protocol.
- **Agent instructions fragment.** Mandible ships a versioned fragment
  describing its own interface (command surface generated from the CLI source,
  trailer semantics, auth lifecycle, coordination primitives).
  `mandible instructions install` maintains it as a marked section in the
  user's agent-instruction files, and Mandible-spawned SDK sessions receive it
  directly. The fragment describes the contract only — it never contains user
  policy.
- **Transports.** The daemon serves HTTP on loopback and a file-RPC spool
  directory for network-isolated (sandboxed) agents. Both dispatch through the
  same router; the file transport excludes approval/admin routes.

### What the contract requires of a host

Git, Node, and a user account. One genuine credential dependency exists today:
**`auth merge` requires a configured git signing identity.** Its preflight
check aborts if `commit.gpgsign` is false or `user.signingkey` is unset. The
*mechanism* is free — GPG or SSH, hardware-backed or file key — but a
no-signing host cannot execute auth merges. This is a deliberate product
stance: the authenticated merge is the trust boundary Mandible exists to
provide. Everything else (ledger, queue submission/approval, artifacts,
sessions) works with no signing configured at all.

At merge time, `auth merge` strips agent-injected `GIT_CONFIG_*` environment
overrides before running git: **merges are user operations** and must be
signed with the user's configured identity, never an agent's.

### What the contract deliberately does not specify

- How commits on feature branches are authored, signed, or attributed.
- Which signing keys exist, what they are named, or where they live.
- Worktree tooling, branch-naming schemes, or merge ceremony below the
  protected branch.
- The content of the user's agent-instruction files outside Mandible's marked
  section.

## Policy layers (worked examples)

**Reference profile (the dotfiles layer this repo is developed against).**
Protected merges signed by a hardware key (YubiKey); feature commits signed by
a file-based agent key (`id_ed25519_agents`), selected by the `agent-commit`
wrapper and by env-scoped `GIT_CONFIG_*` overrides in agent shells;
`agent-commit` adds `Mandible-Issue:` trailers and attribution, and pings the
work-unit API; worktrees managed by `wt`/`wt-merge`/`dwt` with `.worktree.yaml`
shared links. None of these tools are part of Mandible; Mandible consumes
their outputs (trailers, `.issue` files, branch names) when present.

**Solo developer, no signing.** Plain `git commit`, no trailers, no wrapper
tooling. The ledger, dashboard, sessions, and artifacts work fully; commits
are unlinked unless trailers are added by hand. Auth merges are unavailable
until a signing identity is configured — configure one (a plain file SSH key
satisfies the preflight) or merge outside Mandible.

**Team with PR-gated merges.** GitHub PRs are the merge authority; Mandible is
used for the ledger, agent sessions, and artifacts only. The auth queue is
simply unused. Nothing breaks: the queue is a capability, not an obligation.

## Signing is attribution, not authorization

A recurring confusion the layering resolves: feature-branch signatures
(agent keys, file keys) are *attribution* — they record who authored what.
*Authorization* happens exactly once, at the user-approved, user-signed auth
merge into the protected branch (or whatever merge gate a profile substitutes).
Strengthening or weakening feature-commit signing policy therefore never moves
the security boundary; it only changes the quality of the audit trail.

## Degradation table

| Absent on host | Effect |
|---|---|
| `agent-commit` / trailer tooling | Commits unlinked from issues; work units not auto-activated. Everything else intact. |
| Any signing identity | Ledger, queue, artifacts, sessions fine; `auth merge` preflight refuses to execute merges. |
| Dotfiles / instruction files | `mandible instructions install` produces a working interface block from scratch. |
| Network access to loopback (sandboxed agent) | Use the file-RPC transport; approval/admin routes remain UI-only. |
| The daemon | Nothing works by design — the daemon is the single writer. Clients must fail loudly, not fall back to direct DB writes. |

## Rules of thumb for contributors

- New interface ⇒ implement in the daemon/CLI, describe it in the instructions
  fragment (generated, not hand-copied), and keep it policy-free.
- New convention that references user-specific names (keys, paths, tools) ⇒ it
  is policy; it belongs in the user's configuration layer, and Mandible may
  *recognize* its artifacts but must not require them.
- If a contract-layer component is found hard-coding policy (key names, tool
  names, instruction text), treat it as a layering bug and file it.

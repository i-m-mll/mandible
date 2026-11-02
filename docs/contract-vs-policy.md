# Contract vs. policy

Mandible's **contract** comprises the interfaces, invariants, and lifecycle
rules it defines for every installation. **Policy** describes how a particular
user or team chooses to work: for example, branch names, worktree tools, agent
instructions, and which signing keys to use. Mandible provides mechanisms that
policies can use; it should not require one user's conventions.

The [interface contract](../cli/instructions-contract.md) is the source for
Mandible's command and lifecycle behavior. It covers the ledger, work units,
agent sessions, artifacts, approval requests, and available transports. The
command registry supplies its command synopses. `mandible instructions install`
exports the contract to configured targets; those destinations and any surrounding
instructions are user policy.

For example, Mandible records issue and work-unit relationships and executes
protected-branch requests through its approval lifecycle. A user's policy may
choose `wt` for worktrees, `commit-linked` for feature commits, and particular
agent and human signing keys. Those tools and key names belong in that user's
configuration, not in Mandible's required interfaces. Another team may use
different tools or a separate PR process.

Protected-merge authorization and signature verification are product mechanisms,
not merely conventions. A merge request requires an authorized approval and an
attestable signature from an active credential associated with the approving
user; delegated approval has its own credential and authorization rules. The
[protected-branch guard](protected-branch-guard.md) describes signature
attestation, and the [interface contract](../cli/instructions-contract.md)
describes the request lifecycle. Feature-commit signing and attribution remain
user policy.

When adding an interface, implement and document its behavior in Mandible's
contract. Put user-specific names, workflow preferences, and tools in the
user's configuration; Mandible may support their use without depending on them.

Co-Authored-By: Codex (GPT) <codex@openai.com>

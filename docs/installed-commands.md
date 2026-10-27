# Installed commands

The installed release exposes one public command at its manifest's `entrypoints.cli`.
On macOS the path is `<Mandible.app>/Contents/Resources/bin/mandible`, for example:

```sh
/Applications/Mandible.app/Contents/Resources/bin/mandible help
```

Native setup and user-owned command wrappers invoke that absolute path. They do
not locate a checkout, start an ambient Bun, or invoke internal shell scripts.
An installation may be relocated; registrations that store an absolute app path
must be explicitly refreshed when the user moves it.

The public command retains the existing CLI grammar, argument boundaries,
stdin/stdout/stderr, exit status, inherited claimed identity and local transport
selection. It also provides these integration entrypoints:

| Invocation | Contract |
| --- | --- |
| `mandible identity exec -- <command> [args...]` | Scope inherited provider/managed identity using the CLI ownership rules, then exec with the same PID, streams and exit status |
| `mandible settings read` | Settings JSON from `/api/settings` through the CLI local transport and identity |
| `mandible hook session-start` | Project the native Claude ID into `CLAUDE_ENV_FILE`, attach the process and navigation metadata, and summarize escalated inbox items |
| `mandible hook session-end` | End this native Claude session without ending an inherited parent |
| `mandible hook subagent-start` | Register the child and open an optional configured transcript pane |
| `mandible hook subagent-stop` | End the child and write an existing transcript directory’s completion sentinel |
| `mandible hook ingest-nudge` | Claude hook JSON on stdin; best-effort ingestion nudge |
| `mandible hook notification` | Claude notification JSON on stdin |
| `mandible hook statusline` | Claude statusline JSON on stdin; chained statusline output on stdout |
| `mandible hook session-execution claude` | Queue a native Claude execution observation from stdin |
| `mandible hook session-execution codex` | Queue a native Codex execution observation from stdin |
| `mandible channel` | MCP JSON-RPC over stdin/stdout; diagnostics on stderr |
| `mandible git-guard <phase>` | Git reference-transaction phase argument and transaction stdin; nonzero refuses the update |

Generated Claude settings invoke this command with session attribution and any
chained statusline in environment assignments. Provider settings unrelated to
Mandible remain user-owned. The SDK's channel invocation uses the same public
command. CLI identity scoping remains in the existing CLI implementation;
channel and hook inputs retain their respective provider identity contracts.

Lifecycle exports use the existing Mandible-owned hooks and share their payload
identity rules. They complement execution observations, which do not replace
process attachment, native ID projection or navigation. Optional Zellij panes
invoke the user's `agent-viewer` and `zj-query` tools by name, or explicit
`MANDIBLE_AGENT_VIEWER` and `MANDIBLE_ZELLIJ_QUERY` paths. These external terminal
adapters are not resolved through a Mandible checkout or personal dotfiles root.

`identity exec` requires the `--` separator so every following token, including
options and empty arguments, belongs to the executed command. The process stays
the same across dispatch; a caller's PID-based recursion guard remains valid.

A Git hook that dispatches to this command must propagate execution failure.
Missing installed code must never be interpreted as permission to update a
protected branch. The guard continues to read the daemon's durable protection
projection; it does not contact the daemon during Git ref transactions.

## Resource and platform roles

`MANDIBLE_RELEASE_ROOT` explicitly selects the installed release locator and must
be absolute. The public command also recognizes its own colocated `release.json`.
The release contract validates installed entrypoints and native roles. Missing or
incompatible installed resources fail without trying a source checkout or a
runtime store. Prebuilt helpers live in `dist/`; instruction rendering loads
`cli/command-syntax.cjs` and `cli/instructions-contract.md` directly through the
shared resource resolver.

The macOS bootstrap uses `Contents/MacOS/mandible-bun` to load the release contract,
then the pinned runtime's `execve` replaces the launcher. This preserves process
identity, parentage, standard streams and signal behavior. The bundle includes
`cli/main.zsh`, `scripts/installed-command.mjs`, the complete `hooks/` tree
and all compiled CLI helpers. System tools such as Git, curl, jq and diff are
provided by the qualified macOS platform; no Homebrew or developer runtime is
required. Native revision diff invocation is isolated in `src/platform-tools.ts`.

Linux and Windows installers will supply native bootstrap/layout adapters for
the same logical command and resource roles. Linux can use the POSIX command
implementation. Windows needs a native command launcher and command/tool adapter,
including the revision-diff role, before its installed command is enabled. The
command grammar, transport and attribution contracts do not change by platform.
These adapters are not implemented by the macOS release.

## Projected Cowork client

The app contains `cowork-runtime/`: the generic pinned Bun selector, identity
lock, version and hash-verified Bun archives for the host and Linux clients.
The materializer projects these assets beside the shell CLI, renderer and
instruction/reference resources. It removes obsolete files named by its prior
manifest. Runtime extraction and verification receipts stay under the disposable
projected cache, not in the app or a developer store. No source SQLite module or
host-absolute selector shim is projected.

The projected client serves file-RPC commands in the mounted cache. Commands
requiring host-local compiled helpers fail explicitly and must be invoked on the
host through its installed public command. Linux archives are preserved for
portable clients; including an archive is not evidence of execution qualification
for that architecture. Linux execution qualification and Windows packaging remain
separate delivery gates.

## Development and proof

Invoking a source checkout's `bin/mandible` without an installed release selection
uses that checkout's explicit development runtime and TypeScript helpers.
Previews and builds retain their own source workflow. Instruction installation
target defaults are unchanged by installed command support.

After staging an app payload, run:

```sh
scripts/bun-runtime.sh --exec --no-install scripts/prove-installed-commands.mjs /absolute/Mandible.app/Contents/Resources
```

The macOS sandbox proof denies the checkout, dotfiles, developer runtime store,
ambient developer tools and external runtime downloads. It exercises CLI grammar,
prebuilt SQLite access, native-log inspection and parsed blocks, instruction
rendering, generated hook attribution and chained output, execution outbox, MCP
initialization, guarded Git updates and offline projected-client grammar. It is
command evidence; exact signed candidate acceptance remains the production gate.

The focused lifecycle/public-export proof uses the same staged resource root:

```sh
scripts/bun-runtime.sh --exec --no-install scripts/prove-installed-exports.mjs /absolute/Mandible.app/Contents/Resources
```

It runs a real private-socket fixture with isolated ledger state and denies the
source repository, dotfiles and developer runtime stores to the invoked product.
It checks identity-scoped exec PID/streams/arguments/exits, settings read, native
ID projection, process/navigation registration, parent isolation, child lifecycle
and optional terminal adapter invocation.

Co-Authored-By: Codex (GPT) <codex@openai.com>

# Gateway administration

The long-lived gateway uses Caddy's administrative API for configuration reloads.
It listens only on the installation's `config/local-sessions/admin/caddy.sock`,
with socket mode `0600` inside an account-owned `0700` directory. Setup refuses
a substituted file, symlink, foreign owner or broader permissions. The socket
is disposable; canonical registrations and Caddy's CA/storage remain unchanged.
macOS Unix socket paths must fit its 103-byte limit; an oversized installation
path fails explicitly.

`scripts/gateway-admin.mjs` owns endpoint selection, filesystem admission and
the reload client. Reloads name the exact Unix endpoint. There is no TCP admin
fallback. The temporary trust gateway and candidate-acceptance gateway do not
reload, so both disable the administrative API entirely.

An existing TCP-admin gateway needs an owned restart to adopt the new transport.
The controller captures that requirement before replacing the generated config.
An existing config with no listening Unix endpoint also requires restart, so retry
after an interrupted rewrite does not attempt a reload on a nonexistent endpoint.
The check distinguishes a stale socket file from a live listener. Source
start/restart/reload and source handoff use the existing ownership-checked
reconciliation path; native management validates ownership before restarting
the registered gateway. Subsequent reloads keep the serving process alive.
The transition briefly restarts HTTPS serving but retains origins, instance
registrations, session forwarding rules, CA material and leaf storage.

Exact-package activation stops the old owned gateway before the accepted native
gateway starts; the packaged foreground entrypoint prepares the private directory
before launching Caddy. No old TCP administrative API is used during activation.

This is an OS-account boundary: other accounts and browser TCP clients lose
administrative access. Native code running as the owning account can still use
the owner-only socket. Isolation of untrusted code within that account belongs
to the broader local security design.

The Caddy [administrative API](https://caddyserver.com/docs/api) recommends
permissioned Unix sockets, and its [network address convention](https://caddyserver.com/docs/conventions#network-addresses)
supports an explicit permission suffix. The [reload command](https://caddyserver.com/docs/command-line#caddy-reload)
accepts the administrative address separately from the desired configuration.

Run `scripts/bun-runtime.sh --exec test scripts/gateway-admin.test.mjs` for the
isolated native contract. It starts the pinned Caddy on private ports, transitions
from TCP administration to Unix administration, verifies permissions and absence
of an owned TCP admin listener, then reloads real HTTPS main/preview routes without
changing PID. It also verifies that substituted admin entries are preserved and
refused. No production service, system trust or app build is involved.

Co-Authored-By: Codex (GPT) <codex@openai.com>

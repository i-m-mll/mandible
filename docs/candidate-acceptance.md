# Production candidate acceptance

Run the production daemon and packaged desktop from one clean, committed candidate:

```sh
runtime=$(scripts/bun-runtime.sh)
PATH="$(dirname "$runtime"):$PATH" "$runtime" run candidate-acceptance -- \
  --project <canonical-project-id> --work-unit <canonical-delivery-work-unit-id>
```

The project and delivery work unit come from the live Mandible registry. The coordinator supplies its integration work unit for the final gate. No preview, installed application, LaunchAgent, or production database is restarted or replaced.

The command builds both components, verifies the package signature and bundled source marker, launches its own daemon at a free loopback port, and verifies the exact instance, generation, startup commit and epoch. It creates an operator fixture through that daemon's private socket. The packaged webview uses an isolated, nonpersistent browser store, opens Settings, changes the app theme, and checks the persisted preference revision. The window remains open through a full event-loop diagnostics interval. Daemon and native logs are assessed after owned processes stop, including shutdown.

Approval of a runtime self-update request requires a passing result for its exact retained candidate. `mandible auth acceptance run <request>` asks the daemon to check out the request's pin commit in its detached acceptance checkout, run a frozen install, and run this command there. The record binds the candidate tree, reviewed base and reviewed head. A moved base or head makes it stale. `mandible auth acceptance show <request>` reports it.

A passing result is a pre-merge assessment. It does not attest delivery, convergence, native Connections setup, secure gateway trust, or every product workflow. The gate checks meaningful editing in the packaged application; affected feature lanes still supply their own focused behavior evidence.

Each run records its exact project, work-unit owner, instance and generated outputs before producing them. The shared owned-run lifecycle saves a compact receipt outside the scratch root and reclaims disposed raw material after assessment or failure. Unknown files, active consumers, identity drift and cleanup errors preserve the remaining bytes and fail the gate. The receipt contains source and executable hashes, the runtime, interaction evidence, log digest, shutdown results and cleanup outcome. Apparent unlinked bytes are reported separately from physical space recovery.

Missing platform or candidate prerequisites produce `unavailable`; execution, interaction, log or cleanup failures produce `failed`. Only `passed` exits successfully. A failed assessment never authorizes rerunning a protected merge.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

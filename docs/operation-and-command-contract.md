# Operation and command contracts

Every registered HTTP route declares an operation ID, effects, request schema,
reporting category, and file-transport policy. Registration fails if any field is
missing. A null request schema explicitly means the handler validates its input.
Schema transforms run before body-dependent effects are computed. Effects govern
instance-role restrictions; reporting categories govern CLI diagnostics; neither
implies file-transport permission.

`GET /instance` publishes the complete catalog generated from the live router.
Its runtime version, instance ID, and backend generation bind that catalog to the
responding daemon. Mutating HTTP CLI calls reject unknown routes, malformed
catalogs, and identity mismatches before sending the requested mutation. File
transport uses its independently enforced server policy. Readiness health stays
compact and does not duplicate the catalog. The browser loads this catalog once
per daemon generation for action affordances. It can disable actions with static
forbidden effects; a null effects hint explicitly leaves body- and custody-dependent
decisions to daemon ingress. A UI hint never grants credential permission.

`cli/command-syntax.json` is the structural command grammar. Its argument,
option, choice, optional, and repetition nodes generate parsing, help, and the
installed interface instructions. Shell handlers receive safely quoted bindings
from the grammar; native consumers use the same parser. Handlers retain domain
checks and service orchestration, but do not reinterpret argument syntax.

Flattened CLI cache bundles include the canonical Bun selector, version pin,
and platform checksum lock, plus the qualified SQLite installer and its library
identity module under `runtime/`. They select and verify a runtime on
the destination host using the same repository mechanism. Cache manifests record
that complete dependency set and a stable digest of its source paths and bytes;
CLI mutation policy always comes from the responding daemon's live catalog.

Domain event names and payload contracts live in `src/contracts.ts`. Emitters,
worker messages, SSE envelopes, and browser consumers share this vocabulary.
Transport boundaries reject unknown event names and malformed payloads. Provider
console telemetry is the explicit opaque-payload exception.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

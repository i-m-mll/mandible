# Live client data ownership

- Mounted issue and artifact panes use shared Query identities and event invalidation. This gives each fetched resource one live owner, so open panes reconcile external changes while retaining selection and visible content. The displaced detail request hook and duplicate artifact request flows are removed.
- Cancelled cached GETs become unjoinable when their final reader leaves. Replacement reads start fresh transport work, and late completion cannot replace newer cached data.

The broader Graph, Timeline, Spaces payload, and Issues enrichment pipelines still use their existing detail cache. Migrating those resource families needs their own view-state and activation contracts.

Co-Authored-By: Codex (GPT) <codex@openai.com>

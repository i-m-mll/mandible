# Graph and Timeline query ownership

- Graph and Timeline payloads use shared Query identities keyed by their transport inputs. Mounted views and warmers observe the same reads; Graph membership pickers use the Graph query as well.
- Ledger change events invalidate the relevant projection once per event batch. Active views refresh, while hidden views wait until activation. Cached restart snapshots supply paint during a read without becoming another live data owner.
- Graph retains its canvas, viewport, selection, and inspector through topology changes and refresh failures. Timeline retains its row and time-axis view state while one abortable read assembles all pages.
- Projection reads have a bounded deadline, and the startup barrier releases on completion, deactivation, or error.

Spaces packet and Issues enrichment resources remain separate query families. Their ownership and view-state contracts require independent review.

Co-Authored-By: Codex (GPT) <codex@openai.com>

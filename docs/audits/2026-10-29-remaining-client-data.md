# Issues and Spaces data ownership

- Issues uses separate Query entries for initial and complete detail. Complete detail takes precedence regardless of response order. Noncanonical repo-less references resolve through the backend before a cached result can establish repository identity.
- Issue mutations publish into the originating issue's complete Query entry after cancelling older reads. Selection, drafts, and useful same-identity content survive ordinary refresh failures; authoritative missing or ambiguous responses suppress stale content.
- The Spaces shell owns one complete packet Query. Collection and Board derive their views from that packet, while Canvas reconciles each update through its existing drag and pending-write state. Packet metadata and content therefore advance together.
- The document editor uses the same packet for Space items and a separate Query for document blocks. Ledger events and mutations refresh the relevant Query families through one event bridge.
- The displaced live detail-cache request fences, freshness state, and duplicate memory entries are removed. A bounded restart snapshot store remains for initial paint.

Board's resolved item facts are a distinct resource family. Their current resolve-once state can leave status-driven columns stale after a source change; [issue:3a82d98] tracks its live ownership.

Co-Authored-By: Codex (GPT) <codex@openai.com>

# Compact index publication contract

Owned by [issue:673c86b]; consumed by [issue:44569c8]. Physical version is 19. `src/conversations/conversation-index.ts` defines the only body-free semantic model. Source positions retain the existing SHA-256 revision, encoded as 32 bytes on disk. Complete and bounded readers return canonical facts; hydrated renderer items are projected into the same activity summarization rule.

`ConversationStructureCache` exposes `beginGeneration(manifest, priorVersionId?) → number`, `appendGeneration(id, {rows?, display?, tools?})`, `completeGeneration(id)`, and `discardGeneration(id)`. Begin creates a building generation and optionally copies an exact ready prefix. Append commits bounded batches; complete validates contiguous source positions, position facts and owned references before atomically setting ready. Reads admit only ready generations. Conversion leaves source ledger pointers untouched.

The storage module exports `CONVERSATION_CACHE_FORMAT` with version, table ownership and schema SQL, and `projectConversationCache(sourcePath, destinationPath, manifests)` selecting exact ready tuples. Generation-copy and projection use the same ownership inventory. No preview-specific table inventory is required.

`legacyDisplayIndexBatch` converts a bounded batch of parsed v18 position/fragment facts and aliases into canonical facts. This is a conversion-only projection function, not an old-format runtime read backend. Native identity and disclosure strings are decomposed losslessly into typed recipe rows; source and generation scope are referenced rather than repeated. Tool operations store category/count/native names; labels/icons are reconstructed by shared presentation definitions. Execution stores kind and ordered shell/forwarding facts, never command input or script bodies. Semantic text flags fit one integer bitset.

Co-Authored-By: Codex (GPT) <codex@openai.com>

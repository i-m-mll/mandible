# Source demand and availability

- Ingestion now owns one demand per logical source. Pending selected reads strengthen queued work, and reads arriving during weaker work wait for one stronger follow-up. Reconciliation, full ingestion, and direct batches service priority work at each completed-source boundary while retaining one serialized writer. This removes the selected Chat priority inversion without duplicate source writes. [issue:782a50e]
- Search resolves source representation through the shared logical-source boundary. Cold searches include compressed transcripts in verified masked reads, retain raw-file shortlist probing when valid, and never cache an unavailable read as a complete empty result. This makes results independent of prior cache warming and allows recovery when compressed bytes return. [issue:08ea52f]

Validation: 71 focused ingestion tests, 37 focused search tests, 25 combined integration tests, and the full source build passed. The default suite exceeded 60 seconds and exposed a clean-main accepted-package fixture failure, tracked separately as [issue:7c7afb5]. Corpus-wide full-text cost remains [issue:2a96e3d].

Co-Authored-By: Codex (GPT) <codex@openai.com>

# Test dispositions

Each retained file remains executable. Trimming removes incidental presentation
or source assertions while retaining the file's behavioral cases. Retention is
conservative for distinct layers: no similarity result alone authorizes deletion.
This table is a review record, not a second runner whitelist. Directory membership
and the explicit provisioned launcher/macOS paths define execution.

| Original file | Verdict | Protected boundary or deletion reason |
| --- | --- | --- |
| `acp-backend.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `acp-protocol.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `agent-dispatch-ui.test.tsx` | Retain | issue header launch-agent affordance / dispatch dialog contract. Mounted interaction/projection evidence retained. |
| `agent-page-binding.test.ts` | Retain | agent page binding / agentSessionFromHash / adoption. Behavioral, persisted-record, or format boundary retained. |
| `anchored-menu-behavior.test.tsx` | Retain | useAnchoredMenu behavior. Mounted interaction/projection evidence retained. |
| `api-cache.test.ts` | Retain | Briefing SSE cache invalidation matrix / dashboard API GET cache. Behavioral, persisted-record, or format boundary retained. |
| `api-shell-portability.test.ts` | Retain | sourced API shell portability. Process/transport boundary retained. |
| `app-rail-order.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `app-shell-chrome-contract.test.tsx` | Delete | Only CSS/source tokens, theme literals, or presentation structure; interaction semantics remain in shared action/browser cases. |
| `artifact-canonical-consumers.test.ts` | Retain | canonical artifact compatibility consumers. Behavioral, persisted-record, or format boundary retained. |
| `artifact-drafts.test.ts` | Retain | artifact drafts. Behavioral, persisted-record, or format boundary retained. |
| `artifact-ingest-pool.test.ts` | Retain | artifact ingest worker pool / off-thread artifact ingest routes. Behavioral, persisted-record, or format boundary retained. |
| `artifact-media-type.test.ts` | Trim / retain | mediaTypeForPath. Behavioral, persisted-record, or format boundary retained. |
| `artifact-open.test.ts` | Retain | artifact external open. Process/transport boundary retained. |
| `artifact-preview-ui.test.tsx` | Retain | artifact preview helpers / ArtifactDetail artifact preview rendering. Mounted interaction/projection evidence retained. |
| `artifact-series-list.test.ts` | Retain | artifact series list. Behavioral, persisted-record, or format boundary retained. |
| `attribution-evidence-badge.test.tsx` | Retain | evidenceBadgeFor mapping / AttributionIdentity evidence badge rendering. Mounted interaction/projection evidence retained. |
| `attribution-evidence-projection.test.ts` | Retain | attribution read projection exposes evidence_method. Behavioral, persisted-record, or format boundary retained. |
| `auth-action-cli.test.ts` | Retain | auth action CLI. Process/transport boundary retained. |
| `auth-auto-approve-attribution.test.ts` | Retain | delegated signing attribution persistence. Behavioral, persisted-record, or format boundary retained. |
| `auth-check-cli.test.ts` | Retain | auth check CLI. Process/transport boundary retained. |
| `auth-clearance-api.test.ts` | Retain | auth clearance API. Behavioral, persisted-record, or format boundary retained. |
| `auth-clearance-cli.test.ts` | Retain | auth clearance CLI. Process/transport boundary retained. |
| `auth-command-normalization.test.ts` | Retain | normalizeLegacySingleSourceMergeCommand / canonicalAuthMergeCommands hostile-HOME guard. Process/transport boundary retained. |
| `auth-deeplink-detail.test.tsx` | Retain | AuthQueueView deep-linked request outside loaded lists / AuthQueueView short-form request params. Mounted interaction/projection evidence retained. |
| `auth-executor.test.ts` | Retain | executeAuthCommand. Behavioral, persisted-record, or format boundary retained. |
| `auth-finalizer-queue.test.ts` | Retain | auth finalizer queue (Issue 75f52ac). Behavioral, persisted-record, or format boundary retained. |
| `auth-history-summary.test.ts` | Retain | auth history summaries. Behavioral, persisted-record, or format boundary retained. |
| `auth-hooks-panel.test.tsx` | Retain | Approval Hooks settings editor. Mounted interaction/projection evidence retained. |
| `auth-hooks.test.ts` | Retain | AuthHookManager / AuthQueue hook integration. Behavioral, persisted-record, or format boundary retained. |
| `auth-list-cli.test.ts` | Retain | auth list CLI. Process/transport boundary retained. |
| `auth-output-coalescer.test.ts` | Retain | auth output coalescer. Behavioral, persisted-record, or format boundary retained. |
| `auth-request-short-id.test.ts` | Retain | GET /api/auth/request/:id short-form ids / PUT /api/auth/request/:id short-form ids. Behavioral, persisted-record, or format boundary retained. |
| `auth-view-readiness.test.tsx` | Retain | AuthQueueView daemon readiness gate / AuthQueueView persisted action expansion. Mounted interaction/projection evidence retained. |
| `backend-usage-retention.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `briefing-api-v2.test.ts` | Retain | Briefing v2 UI projection. Behavioral, persisted-record, or format boundary retained. |
| `briefing-artifact-rounds-view.test.tsx` | Retain | artifact-backed Briefing rounds. Mounted interaction/projection evidence retained. |
| `briefing-cli.test.ts` | Retain | briefing CLI. Process/transport boundary retained. |
| `briefing-demo-seed.test.ts` | Retain | rich Briefing demo seed command. Process/transport boundary retained. |
| `briefing-directives.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `briefing-document-panel.test.tsx` | Trim / retain | Briefing document panel. Mounted interaction/projection evidence retained. |
| `briefing-round-view-state.test.ts` | Retain | Briefing v2 round draft state. Behavioral, persisted-record, or format boundary retained. |
| `briefing-routes.test.ts` | Retain | plural Briefing routes. Behavioral, persisted-record, or format boundary retained. |
| `briefing-sidebar-item-row.test.tsx` | Trim / retain | Briefing sidebar row actions. Mounted interaction/projection evidence retained. |
| `channel-event-bridge.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `channel-registry.test.ts` | Retain | ChannelRegistry. Behavioral, persisted-record, or format boundary retained. |
| `channel-server.test.ts` | Retain | channel-server base URL / channel-server local socket. Process/transport boundary retained. |
| `chat-context-usage.test.ts` | Retain | chat context usage. Mounted interaction/projection evidence retained. |
| `chat-failure-notice.test.tsx` | Retain | Preview denial, accessible notice, raw-code hiding, diagnostics, retry, and dismissal retained. Literal saved-draft wording retired; canonical draft-state tests prove preservation. |
| `chat-message-stream.test.tsx` | Retain | chat message stream render model / ChatSurface stream behavior. Mounted interaction/projection evidence retained. |
| `chat-project-preferences.test.tsx` | Retain | Chat project preference migration. Mounted interaction/projection evidence retained. |
| `chat-render-orchestration.test.ts` | Retain | chat render orchestration. Behavioral, persisted-record, or format boundary retained. |
| `chat-turn-presentation.test.tsx` | Delete | Only CSS/source tokens, theme literals, or presentation structure; interaction semantics remain in shared action/browser cases. |
| `chrome-icon-cascade.test.ts` | Delete | Only CSS/source tokens, theme literals, or presentation structure; interaction semantics remain in shared action/browser cases. |
| `claude-hooks.test.ts` | Retain | Claude hook routes / Claude hook settings. Process/transport boundary retained. |
| `claude-lane-policy.test.ts` | Retain | Claude lane policy / SessionManager Claude lane defaults. Process/transport boundary retained. |
| `cli-artifact-link.test.ts` | Retain | artifact link CLI / artifact versions CLI display. Process/transport boundary retained. |
| `cli-identity-format.test.ts` | Retain | shared CLI identity formatting. Mounted interaction/projection evidence retained. |
| `client-auth-agent-injection.test.ts` | Retain | agent client-auth provisioning. Process/transport boundary retained. |
| `client-auth-attribution.test.ts` | Retain | client-auth durable attribution. Process/transport boundary retained. |
| `client-auth-ui.test.ts` | Retain | OS-owned browser access / SSE transport. Behavioral, persisted-record, or format boundary retained. |
| `client-auth-webhook.test.ts` | Retain | client-auth operator webhook delivery. Behavioral, persisted-record, or format boundary retained. |
| `client-resilience.test.ts` | Retain | CLI client resilience. Process/transport boundary retained. |
| `codex-thread-archive.test.ts` | Retain | Codex CLI thread archiver / codex thread archive candidates. Process/transport boundary retained. |
| `codex-title-authority.test.ts` | Retain | exact Codex title authority. Behavioral, persisted-record, or format boundary retained. |
| `comment-edit-cli.test.ts` | Retain | comment edit CLI / comment edit file-RPC allowlist. Process/transport boundary retained. |
| `console-composer.test.tsx` | Retire with unreachable Console composer | Canonical Chat draft and mounted managed settings tests protect current behavior. |
| `console-prompt-route.test.ts` | Retain | console prompt route. Process/transport boundary retained. |
| `console-session-create-api.test.ts` | Retain | console session creation payload / canonical Chat project registry payload. Process/transport boundary retained. |
| `console-session-options.test.tsx` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `contextual-action.test.tsx` | Trim / retain | shared contextual action. Mounted interaction/projection evidence retained. |
| `conversation-append-ui.test.ts` | Retain | conversation append SSE merge / sidebar conversation summary merge. Behavioral, persisted-record, or format boundary retained. |
| `conversation-block-filters.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `conversation-composer-placeholder-contract.test.ts` | Delete | Only CSS/source tokens, theme literals, or presentation structure; interaction semantics remain in shared action/browser cases. |
| `conversation-control-ui.test.ts` | Retain | shared conversation control presentation. Behavioral, persisted-record, or format boundary retained. |
| `conversation-custody-routes.test.ts` | Retain | conversation custody routes. Behavioral, persisted-record, or format boundary retained. |
| `conversation-cutover-proof.test.ts` | Retain | conversation cutover compact rebuild / legacy storage reclaim. Process/transport boundary retained. |
| `conversation-detail-shell.test.tsx` | Trim / retain | compact detail pane shell. Mounted interaction/projection evidence retained. |
| `conversation-freshness.test.ts` | Retain | exact conversation freshness. Behavioral, persisted-record, or format boundary retained. |
| `conversation-full-text-ui.test.tsx` | Retain | conversation full-text UI request path. Mounted interaction/projection evidence retained. |
| `conversation-index-benchmark.test.ts` | Retain | db / ingestion. Behavioral, persisted-record, or format boundary retained. |
| `conversation-metadata-routes.test.ts` | Retain | conversation metadata routes. Process/transport boundary retained. |
| `conversation-query-boundary.test.ts` | Retain | Chat Query authority. Behavioral, persisted-record, or format boundary retained. |
| `conversation-search-cache.test.ts` | Retain | disposable conversation search cache. Behavioral, persisted-record, or format boundary retained. |
| `conversation-search-route.test.ts` | Retain | conversation full-text API parity. Behavioral, persisted-record, or format boundary retained. |
| `conversation-sidebar-groups.test.tsx` | Trim / retain | conversation sidebar groups. Mounted interaction/projection evidence retained. |
| `conversation-sidebar-item-row.test.tsx` | Trim / retain | conversation sidebar labeled-item rows. Mounted interaction/projection evidence retained. |
| `conversation-sidebar-projection.test.ts` | Retain | conversation sidebar projection. Process/transport boundary retained. |
| `conversation-source-reader.test.ts` | Retain | versioned conversation source reader. Behavioral, persisted-record, or format boundary retained. |
| `conversations-blocks-route.test.ts` | Retain | conversation blocks route pagination / indexed conversation position window. Behavioral, persisted-record, or format boundary retained. |
| `conversations-cli.test.ts` | Retain | conversations CLI file RPC / conversations CLI canonical HTTP reads. Process/transport boundary retained. |
| `conversations-forks.test.ts` | Retain | conversation browse and fork routes. Behavioral, persisted-record, or format boundary retained. |
| `cowork-cli-cache.test.ts` | Retain | Executes the deployed Bash entry point; checks runtime pin, lock and selector byte custody, stable manifest retries, and content-change invalidation. A neutral generated-file fixture replaces the retired policy-cache table. |
| `daemon-log.test.ts` | Retain | daemon logger / daemon log batching. Process/transport boundary retained. |
| `daemon-memory.test.ts` | Retain | daemon memory diagnostics. Behavioral, persisted-record, or format boundary retained. |
| `daemon-readiness-ui.test.ts` | Retain | daemonNeedsSplash / daemon startup epoch. Behavioral, persisted-record, or format boundary retained. |
| `dashboard-badges.test.ts` | Retain | dashboard badge aggregate. Behavioral, persisted-record, or format boundary retained. |
| `db-lifecycle-harness.test.ts` | Retain | db singleton lifecycle. Behavioral, persisted-record, or format boundary retained. |
| `delegated-signing-resource.test.ts` | Retain | delegated signer reconnect lifecycle. Process/transport boundary retained. |
| `desktop-access.test.ts` | Retain | Native origin and command permission configuration; sole cross-language security boundary, retained pending native executable replacement. |
| `desktop-bootstrap-build.test.ts` | Retain | desktop bootstrap build. Process/transport boundary retained. |
| `detail-cache.test.ts` | Retain | persisted detail cache. Behavioral, persisted-record, or format boundary retained. |
| `detail-pane-footer-contract.test.tsx` | Trim / retain | anchored detail pane footer contract. Mounted interaction/projection evidence retained. |
| `detail-pane-header-contract.test.tsx` | Trim / retain | canonical detail pane header / shared collapsible panel. Mounted interaction/projection evidence retained. |
| `detail-pane-modal-contract.test.tsx` | Retain | DetailPaneModal shell contract. Mounted interaction/projection evidence retained. |
| `detail-pane-notice-contract.test.tsx` | Retain | one app-owned operational notice outlet. Mounted interaction/projection evidence retained. |
| `diff-view.test.tsx` | Retain | DiffView. Mounted interaction/projection evidence retained. |
| `git-read-transport.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `graph-layout.test.ts` | Retain | graph edge classification / deterministic graph layout. Behavioral, persisted-record, or format boundary retained. |
| `graph-persisted-view-state.test.tsx` | Retain | GraphView persisted detail panel state. Mounted interaction/projection evidence retained. |
| `graph.test.ts` | Retain | graph node capping / graph filters. Behavioral, persisted-record, or format boundary retained. |
| `host-user-preferences-routes.test.ts` | Retain | host user Chat project preferences. Behavioral, persisted-record, or format boundary retained. |
| `iab-preview-launcher.test.ts` | Retain | iab-preview launcher. Process/transport boundary retained. |
| `inbox-scoping.test.ts` | Retain | inbox tier query (auth_results) / AuthQueue.markDelivered (powers /api/inbox/delivered/:id). Process/transport boundary retained. |
| `inbox-view.test.tsx` | Trim / retain | Inbox managed reminder occurrence / Inbox shared sidebar header. Mounted interaction/projection evidence retained. |
| `ingestion-actor.test.ts` | Retain | ingestion worker actor. Behavioral, persisted-record, or format boundary retained. |
| `ingestion-claude-title.test.ts` | Retain | Claude provider title ingestion. Behavioral, persisted-record, or format boundary retained. |
| `ingestion-codex-archive-relocation.test.ts` | Retain | codex archive relocation. Behavioral, persisted-record, or format boundary retained. |
| `ingestion-empty-cache.test.ts` | Retain | empty conversation ingest state. Behavioral, persisted-record, or format boundary retained. |
| `ingestion-large-range.test.ts` | Retain | bounded ingestion range reads. Behavioral, persisted-record, or format boundary retained. |
| `ingestion-memory.test.ts` | Retain | ingestion allocation bounds. Behavioral, persisted-record, or format boundary retained. |
| `ingestion-priority-queue.test.ts` | Retain | ingestion priority queue. Behavioral, persisted-record, or format boundary retained. |
| `ingestion-scheduler.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `ingestion-watcher-latency.test.ts` | Retain | watched tail ingestion latency. Behavioral, persisted-record, or format boundary retained. |
| `install-desktop-app.test.ts` | Retain | desktop app installer. Process/transport boundary retained. |
| `instructions-cli.test.ts` | Retain | instructions CLI. Process/transport boundary retained. |
| `instructions.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `issue-attribution-ui.test.tsx` | Retain | issue attribution presentation. Mounted interaction/projection evidence retained. |
| `issue-detail-label-display.test.tsx` | Retain | issue detail label presentation. Mounted interaction/projection evidence retained. |
| `issue-detail-living-links.test.ts` | Retain | issue detail living artifact links. Behavioral, persisted-record, or format boundary retained. |
| `issue-predicate-filter.test.ts` | Retain | issue-predicate filter logic. Behavioral, persisted-record, or format boundary retained. |
| `issue-route-precedence.test.ts` | Retain | issue POST route precedence. Behavioral, persisted-record, or format boundary retained. |
| `issue-summary-projection.test.ts` | Retain | set-based issue summary projection. Behavioral, persisted-record, or format boundary retained. |
| `knowledge-backrefs.test.ts` | Retain | knowledge backrefs. Behavioral, persisted-record, or format boundary retained. |
| `ledger-client-cli.test.ts` | Retain | ledger mechanism CLI client. Process/transport boundary retained. |
| `ledger-graph-adapter.test.ts` | Retain | ledger graph projection. Behavioral, persisted-record, or format boundary retained. |
| `ledger-issue-detail.test.ts` | Retain | ledger issue detail projection. Behavioral, persisted-record, or format boundary retained. |
| `ledger-markdown-tools.test.ts` | Retain | ledger escaped Markdown audit and normalization / ledger issue Markdown export. Behavioral, persisted-record, or format boundary retained. |
| `ledger-migration-gate.test.ts` | Retain | ledger issue projection / ledger relationship routes. Behavioral, persisted-record, or format boundary retained. |
| `loading-skeleton.test.tsx` | Retain | LoadingSkeleton. Mounted interaction/projection evidence retained. |
| `local-ca-lockf.test.ts` | Retain | macOS local CA process-lifetime recovery. Process/transport boundary retained. |
| `local-socket-briefing-policy.test.ts` | Retain | settings-kv / db. Behavioral, persisted-record, or format boundary retained. |
| `logs-view.test.tsx` | Retain | LogsView. Mounted interaction/projection evidence retained. |
| `managed-reminder-projections.test.ts` | Retain | managed reminder Inbox projection. Behavioral, persisted-record, or format boundary retained. |
| `managed-reminder-routes.test.ts` | Retain | managed reminder route admission. Behavioral, persisted-record, or format boundary retained. |
| `managed-reminder-scheduler.test.ts` | Retain | managed reminder scheduler. Behavioral, persisted-record, or format boundary retained. |
| `managed-reminders.test.ts` | Retain | mandible-reminder@1 parser / managed reminder service. Behavioral, persisted-record, or format boundary retained. |
| `mandible-home.test.ts` | Retain | durable-state root (issue 24f0316). Process/transport boundary retained. |
| `markdown-body.test.ts` | Retain | Markdown body escape policy. Behavioral, persisted-record, or format boundary retained. |
| `markdown-render-cache.test.ts` | Retain | markdown render cache. Behavioral, persisted-record, or format boundary retained. |
| `markdown-source-editor-annotations.test.tsx` | Retain | MarkdownSourceEditor external decorations. Mounted interaction/projection evidence retained. |
| `message-block-cards.test.tsx` | Trim / retain | message action cards. Mounted interaction/projection evidence retained. |
| `new-chat-provider-first.test.tsx` | Retain | provider-first new chat. Mounted interaction/projection evidence retained. |
| `operational-incidents-routes.test.ts` | Retain | operational incident API routes. Behavioral, persisted-record, or format boundary retained. |
| `operational-incidents.test.ts` | Retain | operational incident ledger and reconciliation. Behavioral, persisted-record, or format boundary retained. |
| `operational-log-db.test.ts` | Retain | operational log database lifecycle / operational log production guards. Behavioral, persisted-record, or format boundary retained. |
| `operator-bootstrap-route.test.ts` | Retain | operator bootstrap ledger boundary. Behavioral, persisted-record, or format boundary retained. |
| `permission-dialog.test.tsx` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `platform-paths.test.ts` | Retain | platform paths. Behavioral, persisted-record, or format boundary retained. |
| `post-merge-build-dist.test.ts` | Retain | post-merge build hook. Process/transport boundary retained. |
| `process-group-supervisor.test.ts` | Retain | process-group-supervisor. Process/transport boundary retained. |
| `project-cli.test.ts` | Retain | project CLI surface / project CLI read round-trips. Process/transport boundary retained. |
| `project-db-snapshot.test.ts` | Retain | project-db-snapshot. Process/transport boundary retained. |
| `pty-backend-lifecycle.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `reminder-cli.test.ts` | Retain | mandible reminder CLI parser and routing / mandible reminder CLI file-RPC parity. Process/transport boundary retained. |
| `repo-file-register-dialog.test.tsx` | Retired | Live synchronization and authority switching were replaced by immutable publication snapshots; preservation, stale destination, signing failure, import, and explicit review evidence is in ../spaces-publication.test.ts and spaces-publication-ui.test.tsx. |
| `repo-identity.test.ts` | Retain | canonicalRepoKeyForPath / canonicalRepoKeysForRef. Process/transport boundary retained. |
| `resource-refs.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `restart-availability.test.ts` | Retain | restart availability receipt. Behavioral, persisted-record, or format boundary retained. |
| `rich-chat-pane.test.tsx` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `row-coerce.test.ts` | Retain | row coercion helpers. Behavioral, persisted-record, or format boundary retained. |
| `screen-model.test.ts` | Retire with managed PTY scraping; native permission tests replace it | PTY screen detection / PtyScreenObserver. Behavioral, persisted-record, or format boundary retained. |
| `sdk-backend-lifecycle.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `server-router.test.ts` | Retain | Router error handling / Router route policies. Behavioral, persisted-record, or format boundary retained. |
| `session-discovery.test.ts` | Retain | SessionDiscovery. Process/transport boundary retained. |
| `session-identity-mismatch.test.ts` | Retain | session identity mismatch detection. Behavioral, persisted-record, or format boundary retained. |
| `session-manager-codex-archive.test.ts` | Retain | SessionManager Codex archive integration. Process/transport boundary retained. |
| `session-manager-retention.test.ts` | Retain | SessionManager terminal backend retention. Behavioral, persisted-record, or format boundary retained. |
| `session-manager-run-options.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `session-overview-binding.test.tsx` | Retain | SessionOverviewView provider-scoped binding / SessionOverviewView truncated resolution (review C4). Mounted interaction/projection evidence retained. |
| `session-overview-routes.test.ts` | Retain | GET /api/sessions/resolve / GET /api/sessions/resolve with short prefixes. Behavioral, persisted-record, or format boundary retained. |
| `session-run-options.test.ts` | Retain | session run options. Behavioral, persisted-record, or format boundary retained. |
| `settings-delegated-signing.test.tsx` | Retain | delegated signing settings. Mounted interaction/projection evidence retained. |
| `settings-routes.test.ts` | Retain | settings routes. Behavioral, persisted-record, or format boundary retained. |
| `shared-backend-helpers.test.ts` | Retain | shared HTTP helpers / shared database introspection helpers. Behavioral, persisted-record, or format boundary retained. |
| `shared-select-style-contract.test.ts` | Delete | Only CSS/source tokens, theme literals, or presentation structure; interaction semantics remain in shared action/browser cases. |
| `sidebar-disclosure-region.test.tsx` | Retain | SidebarDisclosureRegion through typed SidebarGroupNode consumers. Mounted interaction/projection evidence retained. |
| `sidebar-group-shared.test.tsx` | Trim / retain | shared sidebar group presentation. Mounted interaction/projection evidence retained. |
| `sidebar-item-row.test.tsx` | Trim / retain | SidebarLeadingActionRow / SidebarItemRow. Mounted interaction/projection evidence retained. |
| `sidebar-list-navigation.test.tsx` | Retain | useSidebarListNavigation. Mounted interaction/projection evidence retained. |
| `sidebar-order-preference.test.tsx` | Retain | sidebar order preference hook. Behavioral, persisted-record, or format boundary retained. |
| `sidebar-reorder.test.tsx` | Retain | shared sidebar reorder. Mounted interaction/projection evidence retained. |
| `sidebar-search-filter-header.test.tsx` | Trim / retain | SidebarSearchFilterHeader. Mounted interaction/projection evidence retained. |
| `space-canvas-edges.test.tsx` | Retain | LEDGER_LINK_TYPES / mapLabelToLinkType. Behavioral, persisted-record, or format boundary retained. |
| `space-canvas-react-flow-contract.test.ts` | Retain | Real React Flow applier wiring; the mocked canvas fixture cannot prove third-party update compatibility. |
| `space-canvas.test.tsx` | Retain | partitionOccurrences / shelf vs canvas / occurrencesToGraph + seedLayoutPositions. Mounted interaction/projection evidence retained. |
| `space-cli.test.ts` | Retain | space CLI surface / space CLI write round-trips. Process/transport boundary retained. |
| `space-export-dialog.test.tsx` | Retired | Live synchronization and authority switching were replaced by immutable publication snapshots; preservation, stale destination, signing failure, import, and explicit review evidence is in ../spaces-publication.test.ts and spaces-publication-ui.test.tsx. |
| `space-promote-docs.test.ts` | Retired | The long-lived docs branch and proxy promotion command were removed by explicit immutable publication. Signed snapshot, issue-linked auth, destination drift, retry, and protected-boundary contracts remain in ../spaces-publication.test.ts, ../auth-publication.test.ts, and spaces-publication-ui.test.tsx. |
| `space-seed-dialog.test.tsx` | Retain | SpaceSeedDialog. Mounted interaction/projection evidence retained. |
| `spaces-add-to-space.test.tsx` | Trim / retain | AddToSpace picker / AddToSpace cross-project (default). Mounted interaction/projection evidence retained. |
| `spaces-block-editor.test.tsx` | Retain | blockEditorModel sort keys / managed editing, draft persistence, and reconciliation. Mounted interaction/projection evidence retained. |
| `spaces-board-model.test.ts` | Retain | board default columns from worker_status / manual and filter custom columns. Behavioral, persisted-record, or format boundary retained. |
| `spaces-board-view.test.tsx` | Retain | SpaceBoardRenderer. Mounted interaction/projection evidence retained. |
| `spaces-canvas-mount-reachability.test.tsx` | Retain | renderers. Mounted interaction/projection evidence retained. |
| `spaces-collection-model.test.ts` | Retain | buildSpaceViewModel / projectCollection — tree + ordering. Behavioral, persisted-record, or format boundary retained. |
| `spaces-collection-read.test.ts` | Retain | GET /api/spaces/:id fact packet (C8 read surface). Behavioral, persisted-record, or format boundary retained. |
| `spaces-collection-view.test.tsx` | Retain | SpaceCollectionRenderer. Mounted interaction/projection evidence retained. |
| `spaces-contracts.test.ts` | Retain | spaces contract enums / spaces route responses satisfy the contract types. Behavioral, persisted-record, or format boundary retained. |
| `spaces-custody-editor-ux.test.ts` | Retired | Live synchronization and authority switching were replaced by immutable publication snapshots; preservation, stale destination, signing failure, import, and explicit review evidence is in ../spaces-publication.test.ts and spaces-publication-ui.test.tsx. |
| `spaces-doc-pipeline.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `spaces-doc-refs.test.ts` | Retain | C6 shared parser: spaces-doc.v1 directive extension. Behavioral, persisted-record, or format boundary retained. |
| `spaces-doc-serialize.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `spaces-document-renderer.test.tsx` | Retain | renderSpaceBlocks (C12 + C14a) / DocumentBody render. Mounted interaction/projection evidence retained. |
| `spaces-drift.test.ts` | Retired | Live synchronization and authority switching were replaced by immutable publication snapshots; preservation, stale destination, signing failure, import, and explicit review evidence is in ../spaces-publication.test.ts and spaces-publication-ui.test.tsx. |
| `spaces-export.test.ts` | Retired | Live synchronization and authority switching were replaced by immutable publication snapshots; preservation, stale destination, signing failure, import, and explicit review evidence is in ../spaces-publication.test.ts and spaces-publication-ui.test.tsx. |
| `spaces-exports.test.ts` | Retain | space_exports schema (issue 9041bb3) / space_exports metadata backup classification (issue 9041bb3). Behavioral, persisted-record, or format boundary retained. Distinct export surface; no cross-layer deletion. |
| `spaces-grouped-headings.test.ts` | Retain | (a) zero-space projects are excluded from listSpacesGrouped output / (b) project_key is present on every emitted group. Behavioral, persisted-record, or format boundary retained. |
| `spaces-item-picker.test.tsx` | Retain | SpaceItemPicker projection helpers / SpaceItemPicker component. Mounted interaction/projection evidence retained. |
| `spaces-nav-shell.test.tsx` | Retain | Spaces routing / SpacesViewShell. Mounted interaction/projection evidence retained. |
| `spaces-schema.test.ts` | Retain | spaces core schema (issue b395083) / spaces core schema — metadata backup classification (issue b395083). Behavioral, persisted-record, or format boundary retained. |
| `spaces-sidebar.test.tsx` | Trim / retain | SpacesSidebar render + grouping / SpacesSidebar live filter. Mounted interaction/projection evidence retained. |
| `spaces-toplevel.test.ts` | Retain | spaces v86 nullable project_id schema (issue 812df41) / spaces grouped + top-level listing (issue 812df41). Behavioral, persisted-record, or format boundary retained. |
| `spaces-view-shell-switcher.test.tsx` | Retain | SpacesViewShell home polish. Mounted interaction/projection evidence retained. |
| `spawn-backend.test.ts` | Retire after controller migration | Removed execution path. Replacement evidence: Claude SDK/Codex controller, managed settings, real terminal, and historical session preservation tests. |
| `sse-apply-payloads.test.ts` | Retain | SSE payload application (patch, gap, debounce, heartbeat, reconnect). Behavioral, persisted-record, or format boundary retained. |
| `sse-cross-tab.test.ts` | Retain | cross-tab SSE coordinator. Behavioral, persisted-record, or format boundary retained. |
| `sse-shared-client.test.ts` | Retain | shared SSE client. Behavioral, persisted-record, or format boundary retained. |
| `startup-ingestion-order.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `subagent-shelf-ingestion.test.ts` | Retain | Claude subagent ingestion. Behavioral, persisted-record, or format boundary retained. |
| `system-logs.test.ts` | Retain | system log routes. Behavioral, persisted-record, or format boundary retained. |
| `task-command-protocol.test.ts` | Retain | operator command creation and cancellation / executor authority, receipts, and conflicts. Behavioral, persisted-record, or format boundary retained. |
| `task-inventory-routes.test.ts` | Retain | POST /api/tasks/inventory / GET /api/tasks. Behavioral, persisted-record, or format boundary retained. |
| `tasks-view.test.tsx` | Trim / retain | tasks route registration / taskFact. Mounted interaction/projection evidence retained. |
| `timeline-layout.test.ts` | Retain | buildTimelineLayout. Behavioral, persisted-record, or format boundary retained. |
| `timeline-projection.test.ts` | Retain | project timeline projection. Behavioral, persisted-record, or format boundary retained. |
| `timeline-time.test.ts` | Retain | timeline time helpers. Behavioral, persisted-record, or format boundary retained. |
| `timeline-ui.test.tsx` | Trim / retain | Mounted state, shared time coordinates, one native scroller, selection and bounded projection-fetch behavior remain. Removed a CSS-literal test; adjacent mounted scroller and axis interactions protect the behavior. |
| `transport-lane.test.ts` | Default | Sole named boundary readmission; see ../README.md. |
| `typography-settings.test.tsx` | Trim / retain | typed typography settings. Mounted interaction/projection evidence retained. |
| `ui-static-assets.test.ts` | Retain | UI static asset delivery. Process/transport boundary retained. |
| `ui-utilities.test.ts` | Replace | Sanitizer behavior in ui-markdown-security; retire formatting/copy restatements. |
| `use-keyed-async-detail.test.tsx` | Retain | useKeyedAsyncDetail. Mounted interaction/projection evidence retained. |
| `use-persisted-view-state.test.tsx` | Retain | usePersistedViewState. Mounted interaction/projection evidence retained. |
| `user-cli.test.ts` | Retain | user list CLI. Process/transport boundary retained. |
| `user-credential-cli.test.ts` | Retain | user credential CLI. Process/transport boundary retained. |
| `user-settings-routes.test.ts` | Retain | authenticated user settings routes. Behavioral, persisted-record, or format boundary retained. |
| `user-setup-signing-credential.test.ts` | Retain | mandible user setup signing credential. Process/transport boundary retained. |
| `view-sidebar.test.tsx` | Trim / retain | ViewSidebar. Mounted interaction/projection evidence retained. |
| `webhooks.test.ts` | Retain | index / tokens. Behavioral, persisted-record, or format boundary retained. |
| `work-audit.test.ts` | Retain | work audit projection / GET /api/work/repos/:id/audit. Behavioral, persisted-record, or format boundary retained. |
| `work-contextual-action.test.tsx` | Trim / retain | work. Mounted interaction/projection evidence retained. |
| `work-overview-preview-capabilities.test.tsx` | Retain | client-auth-token / api. Mounted interaction/projection evidence retained. |
| `work-overview.test.ts` | Retain | work-scanner / work. Process/transport boundary retained. |
| `work-scanner-scan-roots.test.ts` | Retain | parseWorkScannerScanRoots / dedupeScanRoots. Behavioral, persisted-record, or format boundary retained. |
| `workflows.test.ts` | Retain | workflow run ingestion. Behavioral, persisted-record, or format boundary retained. |
| `wrap-session-token.test.ts` | Retain | cli/wrap.sh local identity. Process/transport boundary retained. |

The former `test/ui.test.ts` is replaced by default routing, SSE reduction,
API-client, and Markdown security boundaries plus these rendered boundaries:
- `app-reconciliation` — app reconciliation.
- `settings-behavior` — settings behavior.
- `auth-view-state` — auth view state.
- `work-view-state` — work view state.
- `issue-navigation` — issue navigation.
- `sidebar-resize-state` — sidebar resize state.
- `issue-detail-state` — issue detail state.
- `artifact-view-state` — artifact view state.

The rendered fixture is shared in `test/helpers/ui-workspace-fixture.ts`.
Its hooks reset client access, cached projections, browser storage, and stream
ownership between cases. Pure files do not import the fixture or mounted views.
Private fixture paths use anonymous sample repositories, retaining spaces where
path quoting matters.

The inherited hash-check script is deleted. Useful history, search, snapshot,
Inbox, chat, and sidebar behavior is readmitted to execution rather than changing
hashes. Resource-heavy artifact ingestion and demo-seed tests also return to
ordinary isolated execution; a resource failure remains visible and requires a
current repair. No successful behavioral or resource run is implied by this table.

Browser reliability owns its unmerged files and delivery safety owns its new
proof cases. Their integrated results and actual fixtures determine the final
verdict; failures will not be classified away to hide product regressions.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

## Managed controller consolidation (ccbb795)

The retired SDK/ACP/spawn/managed-PTY tests above exercise execution paths removed after both retained providers passed one bounded live conversation. Their contract evidence now lives in `test/claude-sdk-controller.test.ts`, `test/conversation-controller-adapters.test.ts`, `test/conversation-control.test.ts`, `managed-conversation-controls.test.tsx`, `issue-resume-assignment.test.ts`, `terminal-runtime.test.ts`, and the historical-session and retention tests. Generic historical run-option composition and Composer behavior remain. Console route tests now prove real-terminal authority and refuse managed mutations; webhook tests retain authorization checks and prove undeliverable terminal-targeted messages remain queued. No test moved out of the default runner to suppress a failure.

The rich copied-preview round trip now runs in
`briefing-copied-preview-roundtrip.test.tsx`, with shared private database and
browser fixtures in `helpers/briefing-preview-fixtures.ts`. It still executes in
the extended gate and verifies all six answer controls, exact actor/round frozen
membership, annotation persistence, reload, and wrong-round refusals. The original
36 projection, reconciliation, and authority cases remain in the rounds view file.
The split bounds the heavy integration lifecycle without changing the 950,000 KiB
process-tree limit or retiring evidence.

Authorization fixture adjudication preserves real operator-proof approval and
signed candidate publication. Raw historical rows test read projections and
refusals only. Queue admission is tested at the bounded queue; staged actions,
hook convergence, exact candidate recovery, sibling pinning, and finalizer replay
continue through authoritative publication. Unsigned ancestry alone cannot turn a
pending request into an approved or finalized merge.

CLI follow-up retains executable transport and grammar boundaries. Artifact link
help-copy duplication, three synthetic comment-edit router-template assertions,
and Briefing help/prose duplicates are retired; typed artifact identity, actual
CLI round trips, stale revisions, invalid inputs, snapshot selection and registered
route-policy coverage remain. Instruction targets retain preservation, hooks,
symlinks and protected-target behavior. Project, Space, reminder, user credentials,
ledger client and auth list keep their behavioral cases under the typed catalog.

The CLI worker's final checkpoint retains actual deployed cache entry-point and
artifact-link evidence. `cli-instance-preflight` now verifies five HTTP rejection
paths perform no mutation, replacing helper-only restatements; its 31 cases remain
executable. Reported focused results are 13 cache/artifact-link cases and 22 default
artifact cases passing. Signed CLI checkpoints are `bfc627be`, `5741d506`, and
`7ef66fb6`, after operations `93c96ab6`; the parent integrates that separate lane.

The UI reachability gate also identified eight unused Console modules and the retired stream cache. They are removed without deleting browser storage or historical Console records. The canonical Chat draft tests preserve current composer intent; the generic sidebar fixture uses simple content for its layout contract.

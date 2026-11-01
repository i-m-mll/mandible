# Chat source and reading-window contracts

## Source publication

`conversation_sources` persists `position_space_id`, `position_count`,
`position_fingerprint`, `position_fingerprint_version`, and
`publication_revision`. Publication commits these facts with the current source
version and parser, normalization, and redaction epochs. No normalized message
bodies are retained in the ledger.

`preparePositionSpace` chains normalized item identities in canonical position
order. Native identities use the established provider item/tool/turn and content
index contract, including the normalized subitem ordinal when a native content
index is absent. Their content may change without changing identity. Immutable
id-less items use canonical semantic content, excluding source coordinates and
display projection metadata. Display block IDs are not identity evidence.
Intent receipt enrichment is excluded from position identity. When a provider
echo enriches a prompt's view identity, the fingerprint continues to use the
original provider item identity, or the same id-less semantic fingerprint.

A verified append extends the prior chain from the persisted count. A full parse
compares its prefix at the prior count; identical rebuilds and prefix-preserving
extensions retain the token. Truncation, changed identity/order, or changed
parser/normalization/redaction epochs allocate a new token. Append mode without
a verified source snapshot and prior identity proof is refused. Existing indexes
without a token are rebuilt through ordinary source readiness and publication.

The disposable structure index retains the exact echoed `client_intent_id` so
bounded record hydration does not lose an identity supplied in a later provider
receipt record. Exact delivered outbox receipts can also bind a durable prompt
to its intent. Neither path compares prompt text or creates a legacy ID map.

## Snapshot reads and links

Window and structure responses carry `position_space_id`, `source_version_id`,
and `publication_revision`. Revision is monotonic publication freshness, not a
position coordinate. Window reads pin the captured source version and validate
the publication again after reading bytes. A publication race returns
`freshness_pending`; a space change returns `position_space_changed`.

`expected_position_space_id` guards window, detail, and structure requests.
Mismatch returns HTTP 409 with `code: "position_space_changed"` and the current
token. Detail remains the position-window route with `position`, `limit=1`, and
no display projection. Unscoped canonical positions address the current space.
New message URLs carry `position_space`, the canonical block coordinate, and
the existing origin/session binding. A scoped old position is never rebound.

## Query and the active span

Query remains the fetched-data authority. `ConversationTranscriptData` contains
the source snapshot, cached blocks/intervals, and a separate contiguous
`active_window`. `activeConversationBlocks` is the active-list projection;
cached distant ranges do not extend it.

`applyReadingWindowOperation` accepts `extend-start`, `extend-end`, `trim-start`,
`trim-end`, and `replace`. Adjacent extension refuses holes. Trim refuses removal
of any supplied protected region, which includes the viewport plus overscan and
focused/selected content. `retainReadingWindow` removes only edges and bounds
positions and bytes. Capacity failure is explicit and leaves the current data
intact. The canonical cursor advances through hidden telemetry independently
of whether the renderer emits a visible row.

Replacement requires a readable target and returns its reveal command with the
new data in one result. The caller commits both together. Source coordinates
are `{conversationId, positionSpaceId, position, subtarget?, offset?}`; native
turn IDs are not accepted as position coordinates. Older publication replies
cannot regress aggregate metadata. Ordinary append and detail hydration in the
same space preserve the active span.

The aggregate's `block_source_versions` records freshness for each retained
block. `conversationBlockDetailsCurrent` admits full detail only for the current
source version. A later compact read replaces old full content even when another
range has already advanced the aggregate's version; full content wins over a
compact read only when their individual source versions match.

`ReadingWindowRequests` supervises transports supplied by Query. It deduplicates
by conversation/space/normalized range, admits at most two simultaneous reads,
attaches the expected space, and cancels requests on scope changes. Cancelled
late completions have no selected-data result. It stores no fetched blocks.

## Projection and renderer integration

`projectReadingRows` projects canonical semantic items without grouping them
backward from a window edge. Provider-native and intent keys are view identity;
id-less durable rows use conversation/space/position. Canonical source links are
separate from those view keys. Provisional output has no invented source link.

The disposable source index assigns activity ownership and complete canonical
speaker runs during publication. Append generations extend the trailing run.
Each position window carries bounded `reading_context.positions` entries
`{position, activity_owner_position, speaker_run_start}` and deduplicated
`reading_context.speaker_runs` entries `{start, end}`, captured with the same
source version, position space and publication revision as its blocks. Range
reads join indexed scopes; they neither parse bodies nor scan the full history.
Chat never fetches the complete structure. Query retains context only for its
cached blocks and updates scopes by stable `(position space, start)` identity.
Closed owners have one summary; expansion exposes individually keyed members.
Closed summaries retain their view identity when members at a window edge are
trimmed, without pinning every hidden member.

Copy all/Open turn supplies `speaker_run_start` and the expected position space
to source export on invocation. The server resolves the current complete scope
from the index and reads just that range in one pinned source session. A newly
appended member of that speaker run is included even if the client window has
not refreshed. An obsolete position space is rejected. The same pinned export returns exact
`covered_member_keys` from provider-native identities and durable intent receipts.
On invocation, Chat captures the provisional members of that contiguous semantic
run and appends only members not covered by the export. A wholly provisional
run serializes only its own contiguous members. Shared speaker semantics bind a
provisional suffix to canonical aggregate actions without assigning it a source
link.

Membership maps each canonical position to its row key, disclosure path and
stable source subtarget. `viewMembership` also maps native/intent member keys to
that membership, including closed summaries. When durable source membership
replaces a provisional row with a closed summary, the prior native key resolves
to the exact canonical member and disclosure path. The viewport uses this map
for the explicit replacement/reveal handoff when row identity cannot be kept.
Renderer preparation materializes lazy/disclosed
content and registers the exact focusable target inside the measured row box.
`ReadingRevealResult` distinguishes success, cancellation, unavailable/changed
source, non-renderable content and unsuccessful alignment. This layer issues no
scroll commands and defines no geometry.

## Measured viewport

`useReadingViewport` is the sole scroll owner. TanStack React Virtual 3.14.25
and core 3.19.10 measure normally ordered semantic boxes in one native scroller.
The engine uses end anchoring, its default resize compensation, direct DOM
updates, native scrollend support and cached offscreen size hints. It never
receives a content-type height table, a global history spacer or a cache reset
on reflow. The shared shell publishes its measured composer clearance as
`scrollClearance`; the adapter accounts for it in `paddingEnd`.

Query commits a replacement window and `reading_command` together. The adapter
supervises one cancellable preparation, materialization, alignment and terminal
result. Renderers prepare their disclosures and full details, then register
exact focus targets within the measured box. The adapter materializes by public
`scrollToIndex`, calls public `cancelScroll`, and performs one final
`scrollToOffset` from current measured geometry. Visibility at attainable
alignment and scrolling settlement determine success; a safety deadline is a
failure. Jump to latest replaces with the actual tail and uses `scrollToEnd`.
Ordinary refreshes carry the expected position space. A changed space preserves
the useful current window and exposes an explicit Open current source action;
that action performs a commanded replacement. Wheel, touch, scrolling keys and native scrollbar input cancel source navigation
and engine reconciliation. Editable keyboard behavior is retained.

`viewMembership` supplies an explicit reveal when a settled provisional anchor
becomes a canonical closed summary. Explicit collapse uses the same protocol to
reveal the summary. Routine prepend, trim, append and reflow compensation belong
to the engine. Following is enabled only when the active source span reaches
the captured true end; an older window's bottom cannot enable it.

Local version 2 state is scoped to the canonical conversation. It contains a
position-space anchor and measured local offset, or the following flag, and at
most 100 open disclosure keys. Writes happen at settlement, explicit disclosure
changes and lifecycle exits. An explicit URL wins over stored state. Restoration
loads the anchor window before revealing it; changed or unavailable spaces
produce an explicit outcome. Obsolete group/pixel coordinates are discarded.

The native scrollbar describes only the materialized reading window. Engine
range transitions load adjacent canonical ranges through Query, including
windows consisting entirely of hidden telemetry. Retention protects viewport,
overscan, focus and native text selection and bounds fetched positions and
bytes. Source actions, Markdown serialization and clipboard work occur only on
invocation. The shared hover rail, exact Copy link and turn action meanings are
independent of virtual row boundaries.

Browser and packaged-product acceptance follow the source and protocol checks.

Co-Authored-By: Codex (GPT) <codex@openai.com>

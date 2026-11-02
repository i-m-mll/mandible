# Chat source and reading-window contracts

## Source display context

`src/presentation/` owns the existing DOM-free semantic pairing, inline
directive expansion, tool classification and activity summary rules. Source
publication and live projection both use `projectDisplayFragments`; each part
is scoped to its native/intent member and has a canonical `{position, part}`
coordinate when persisted. Prose separates activity runs even when the prose
and directive share one source message. The disposable index records maximal
consecutive activity runs and verified result-to-call aliases using those rules.

Window `display_context` version 1 returns only fragments for requested positions
and their referenced runs/owners. Runs have stable first/last fragment coordinates,
complete member counts and the exact existing summary, icon and disclosure facts.
Their identity is the first canonical fragment, independent of loaded edges.
Mergeable summary facts preserve consecutive canonical/live nesting and wording.
The index stores structural facts and contributor references; body-derived labels
and exact tool headers are hydrated ephemerally from contributing source records.
No summary text cap changes the existing presentation. Context is validated
against the same source version, position space and publication as the window.

A result-only window can reference a verified off-window call shell, including
its stable member identity, source action scope and exact source-derived header.
It retains both source memberships without extending the active history span.
Unknown parents retain the existing unmatched-result presentation. Query retains
explicitly hydrated owner details only while their owning fragments/results are
retained, under the same source freshness and byte limits. This bounded context continues to support source windows. The complete manifest
below supplies presentation authority independently of the active window.

## Complete presentation manifest and bounded row reads

`GET /api/conversations/:id/reading-manifest` returns a body-free complete
`ConversationReadingManifest`, captured under one position space, source version
and publication revision. `expected_position_space_id` rejects an obsolete space.
The disposable index supplies complete fragment order, maximal activity runs,
verified result-to-call memberships, action scopes, token usage and opaque
rendering-dependency fingerprints. Summary contributors remain exact source
references; the manifest contains no source text or body-derived summary text.

`planConversationReading(manifest, expanded, streaming)` in
`src/presentation/reading-manifest.ts` uses the same `planReadingLayout` as
`projectReadingRows` in `src/presentation/reading.ts`. It supplies all visible
row descriptors and cold/folded memberships without loading their bodies.
Descriptors include source references, disclosure ownership, turn/activity
boundaries, token footer placement, unique keys and opaque dependency revisions.
Manifest summary labels are structural facts only; rendering uses hydrated
presentation. Group disclosure state participates in the descriptor revision;
local body disclosure state extends it at the renderer boundary.

`POST /api/conversations/:id/reading-rows` accepts
`{positionSpaceId, rows: [{key, revision}], expanded, streaming?}`. It returns
only the requested existing `ReadingRow` payloads, with their revisions and the
captured source metadata. A newer publication can satisfy a prior descriptor
when its position space and dependencies remain unchanged. Appending unrelated
content preserves completed prefix revisions. Changed call results, summaries,
boundaries and token footers invalidate the affected rows. A publication advance during hydration is admitted when the current manifest
proves the requested dependencies unchanged; the response keeps the captured
source provenance. Changed requested dependencies
return `changed`; obsolete spaces return `position-space-changed`; missing or
unsupported source returns `unavailable`.

A batch admits at most 128 rows and 512 source positions in one captured read,
and at most 4 MiB of rendered payload. A row that cannot fit reports
`resource-limit`, without truncation or an exact-geometry claim. Source bodies
are ephemeral. The server retains at most one complete metadata manifest and
two disclosure plans per ledger connection; it retains no hydrated row cache.
The client continues to own fetched-data retention through Query. These APIs
contain no pixel coordinates or scrolling policy.

`prepareReadingMembers` and `materializePreparedReadingRows` expose the existing
fragment preparation and renderer-payload phases. `composeConversationReading`
in `src/presentation/reading-composition.ts` merges complete canonical metadata
with provisional events through the same planner. Sourced active-window events
cannot replace manifest authority. Unambiguous native/intent handoffs remove
durable echoes; a unique unfinished canonical call can receive a live result
without inventing a canonical result coordinate or a second presentation member.
The composition supplies action runs containing every local export contributor.

`readingCompositionRequests` resolves mixed row refs to canonical-only source
refs. `materializeConversationReading` validates those payload revisions and
combines their prepared members with local nodes. Descriptor `memberKeys` retain
complete logical membership; bounded payload `materializedMemberKeys` map the
actually hydrated nodes. `activityRun` supplies exact canonical aggregate facts,
including singleton context needed when a live suffix grows a group. No live
text is sent to the source index or stored in the manifest.

Shared `reading-disclosures.ts` supplies renderer disclosure keys and prefix
relations. Effective content-row revisions include only their own disclosure
state. Row-local effective thinking defaults and active tool state also participate: ending a stream or changing its active turn invalidates the affected boxes while explicit overrides and unrelated history remain reusable. The renderer consumes the same shared default rule. Disposable index version 11 carries the body-free default dependencies. Opening or revealing a native-backed call hydrates its exact call and
paired result through the normal row request; `detailsLoaded: true` is emitted
only for bodies read from that captured source. Call and result memberships and
focus subtargets remain distinct. Default-visible transport status evidence
remains visible after detail hydration. Such evidence contributes to complete
membership while preserving the established substantive aggregate summary
wording and icon; an all-status run retains its own existing summary.

`ConversationSourceReader.readPositions` admits one navigation snapshot and
looks up requested coordinates and required direct parents together. Native
record ranges and parsing are deduplicated across the request. Reads proceed in
byte-bounded chunks under one verified lease; a native record remains an
indivisible parse bounded by the existing record and batch limits. Only requested
normalized positions are returned, once each in canonical order. Source,
redaction and cancellation proofs still bracket the admitted read and its chunks.
No body cache outlives that source session. The [same-source acquisition comparison](chat-source-acquisition.json)
records a focused public-batch measurement and its exact payload proof.

The [same-source qualification](chat-source-qualification.json) records the preserved
100-chat corpus, default row and summary parity, restored exact result memberships,
and bounded public-source hydration outcomes. Native inputs remain local.

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

## Query and bounded source windows

Query remains the fetched-data authority. Initial source reads and live reconciliation retain bounded source windows independently of the complete presentation extent. `ConversationTranscriptData` contains
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
backward from a window edge. Every durable fragment uses conversation/position-space/position/part identity.
Provider-native and intent keys authorize a handoff only when their source
membership is unambiguous; duplicate native keys never identify a canonical row.
Canonical source links retain their exact call/result coordinates. Provisional output has no invented source link.

The disposable source index assigns activity ownership and complete canonical
speaker runs during publication. Append generations extend the trailing run.
Each position window carries bounded `reading_context.positions` entries
`{position, activity_owner_position, speaker_run_start}` and deduplicated
`reading_context.speaker_runs` entries `{start, end}`, captured with the same
source version, position space and publication revision as its blocks. Range
reads join indexed scopes; they neither parse bodies nor scan the full history.
The body-free complete reading manifest supplies global presentation metadata. Source-window Query context covers only its
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
to the exact canonical member and disclosure path. The viewport uses verified membership when an applied logical row becomes a canonical row or folded summary.
Renderer preparation materializes lazy/disclosed
content and registers the exact focusable target inside the measured row box.
`ReadingRevealResult` distinguishes success, cancellation, unavailable/changed
source, non-renderable content and unsuccessful alignment. This layer issues no
scroll commands and defines no geometry.

## Measured viewport

`useCompleteReading` owns complete descriptor planning and bounded row payloads
through Query. Payload custody uses row key, dependency revision and local
presentation identity. Applied visible/overscan, focused/selected, pending
geometry and active measurement/reveal candidates may coexist while a new
transaction is prepared. Old visible payloads remain paintable until their
geometry is replaced. Released bodies never reduce the complete row count or
extent. Independent transport ownership prevents cancellation of an obsolete
measurement from cancelling visible hydration.

`ReadingMeasurementService` uses `ReadingRowView` under the real CSS ancestry,
with the same action controls and message-link context as the visible row.
Production measures one current layout. Query leases retain one bounded acquisition buffer of up to 128 source rows while DOM slices stay at or below 16 rows. Acquisition is independent of render slicing. Bounded batches yield between mounts;
measured synchronous work adjusts the following production batch within its
maximum. A single indivisible renderer remains an explicit limit. Finite
calibration layouts retain one mounted batch across widths. Mounted row layout
triggers font discovery before readiness; authoritative border boxes are read
after font/image settlement. Failed images retain the renderer's terminal
failed/alt presentation. Late font loads advance the layout generation.

`useReadingGeometry` retains one compatible complete exact basis and reusable
current-layout facts. First display waits for complete exact geometry, initial
disclosure preparation, navigation and initial payload hydration. Loading,
confirmed empty and source/render failure remain distinct. There is no cold
row-count estimate or guaranteed first-open deadline. Source appends retain
unchanged measurements and replace only new or changed dependencies; ongoing
publication does not restart a completed prefix. Obsolete width work is stopped.

A width change scales the last compatible complete vector by the frozen global
resize profile while exact work proceeds. Lookup uses actual common-row width,
CSS's `--reading-responsive-variant`, and reciprocal-width interpolation between
measured coordinates, with endpoint clamping of the estimate only. Both
responsive variants use each calibration chat's wide 800px-pane height as their
normalization, so crossing the responsive rule preserves relative scale. This
changes neither UI widths nor exact measurements. Geometry-affecting font/style
changes invalidate incompatible facts. The profile is fixed rather than learned
from runtime use.

`useReadingViewport` is the sole scroll adapter. TanStack React Virtual 3.14.25
and core 3.19.10 receive the complete row count, unique keys and committed sizes
through `estimateSize`. They own global offsets, rendered ranges, total extent
and scroll writes. No `measureElement`, `resizeItem`, private cache writes,
competing prefix index or scroller remount participates. Each coherent geometry
transaction calls public `measure()` once and rebuilds the lazy offset index
through a public size read. JSX commits that rebuilt canvas extent before the
adapter restores one logical row/local offset or following intent through public engine offsets. Verified memberships
preserve anchors when provisional content becomes a canonical row or summary.

Sorted mounted rows share one stably keyed normal-flow strip. Consecutive rows
have no geometry-derived gap; absent index ranges use the engine's public
trailing/leading offsets. A reader strip begins at its first virtual start. A
strip that includes the final row uses the public trailing offset to
anchor its bottom, so prose reflow cannot leave the final tool behind or create
blank tail space before new global geometry arrives. Measurement batches keep
their independent common origin under the measurement host.
Following intent alone does not switch this physical reference when native input
moves away from the end.

Mounted frame and target positions are authoritative for alignment and saved
offsets; engine positions locate unmounted rows. The same viewport adapter
corrects the captured DOM text point during local resize observation and layout
commits, before paint, using the native offset plus the actual glyph displacement.
This local correction does not rebuild the global index and yields to native
input. Native scroll rounding is measured separately from content displacement.

Native drag, touch, momentum and scrolling keys defer queued geometry; the
newest compatible transaction uses the current reader anchor when interaction
settles. New input cancels obsolete explicit navigation and captured anchors.
The visible body and its geometry-affecting renderer props come from the same
applied snapshot. Range changes hydrate distant bodies directly at global row
indices. Focus and native text selection keep their rows mounted. Padding starts
at 32px; measured composer `scrollClearance` supplies `paddingEnd` with a 16px
minimum. These chrome contributions are separate from width-scaled row boxes.
The actual browser's native row and total extent capacity is probed and checked
against measured geometry plus current chrome; unsupported extents are explicit.

Source reveal prepares the exact canonical member, disclosure keys and paired
details under the expected position space, waits for matching applied exact
geometry, materializes its global range and aligns the registered source target.
Call and result subtargets remain distinct. The command reports a terminal
result; cancellation never substitutes a nearby source item. Jump to latest uses
this same global adapter and then clears route reading intent, without replacing
an active source window for its extent.

Local version 4 reading state is scoped to the canonical conversation and
position space. Its row anchor stores stable row/member identity, a representative canonical position when available, and the mounted DOM row-top offset when available, otherwise the applied engine offset, independently of body arrival. Local restore resolves the complete plan and aligns the frame without opening disclosures; canonical URL/source reveal remains separate. Older stored source anchors decode as source intent. State also records following intent and at most 100 explicit Boolean disclosure keys. Explicit URL intent
wins. Settlement and lifecycle exits persist the logical state. Copy all/Open
turn and native source-link meanings remain independent of virtual row bounds.

Browser and packaged-product acceptance follow the source and protocol checks.

Co-Authored-By: Codex (GPT) <codex@openai.com>

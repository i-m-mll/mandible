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

`activityOwners` computes canonical summary ownership from the complete source
structure, including tool parent relationships. Closed owners have one summary;
expansion exposes individually keyed members. `sourceActionGroups` records the
complete canonical speaker-run extent so Copy all/Open turn does not silently
export only the clipped loaded range. Export is performed on invocation.

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

## Viewport cutover

The viewport adapter consumes the active list and commits replacement commands
with it. It supplies protected regions to retention, loads adjacent canonical
ranges through Query, prepares disclosures/details and registers measured rows
and source targets. It derives true-end availability from the active span and
the captured total, rather than distant cache membership. The complete cutover
also installs the pinned engine, removes the displaced scrolling machinery,
implements the reveal/restore transaction and bounded view persistence, and
preserves the shared rail/action semantics. Browser and packaged-product
acceptance follow that cutover.

Co-Authored-By: Codex (GPT) <codex@openai.com>

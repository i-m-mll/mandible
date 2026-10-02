# Interface annotation and Chat attachments

## Outcome

Users annotate Mandible directly, then paste annotations into the currently open Chat draft or export a complete packet. Chat also accepts multiple text/code files and images. Keep the interface compact, preserve user state, and retain one canonical attachment representation through drafting, submission, provider delivery, and preview.

## Annotator interaction

A crosshair action lives near the bottom of the global navigation rail, above Settings. It opens a small floating top-centre strip. The strip and saved annotation bubbles share the existing blue accent treatment. Its sole persistent explanatory text is “Annotating”; buttons use tooltips and accessible names. Controls are Paste (clipboard), Export (export/download), Clear (trash), Undo (counterclockwise arrow), and Dismiss (x). There is no right-side panel, chat destination menu, or new-chat action.

Hover outlines a selectable element. Click selects an element; drag selects a rectangular region. Selecting prevents the normal underlying action. A small anchored popover accepts comment text and a check button saves it. Only saved annotations receive blue speech bubbles with white ordinals. Clicking a bubble reopens the editable popover; saving updates it. Capture the selected UI without the annotator's own controls obscuring it. Retain page route, viewport, selected bounds, relevant element identity/text, and build revision when available. A selector is contextual evidence, not guaranteed permanent identity. Hidden or missing anchors must not attach pins to unrelated elements.

Dismiss and Escape hide annotator controls and bubbles without clearing saved annotations. Saved annotations and the recovery cache survive navigation, refresh, and app restart. Opening restores them. Pins are shown only on their originating page/context. Preserve an unfinished comment while dismissing/reopening, or cancel only the unsaved selection explicitly; do not silently lose a saved annotation.

Paste is disabled unless saved annotations exist and a writable Chat composer is actually visible in the Chat view. Paste atomically adds one attachment per annotation to that chat's durable draft, preserving its text and existing attachments; only after success does it empty the active annotation set. It does not submit a message. Switching chats during this operation must not redirect delivery. Each pill reads “Annotation 1”, “Annotation 2”, etc. Attachment snapshots are independent of later restored annotation edits.

Clear empties the active set. Both successful Clear and successful Paste cache the removed set as the one most recently cleared set. Empty Clear is a no-op and must not destroy Undo. Undo restores the cached set without deleting newer annotations or duplicating stable annotation identities, then consumes that recovery entry. Undo after Paste never silently removes or mutates attachments already in the draft. Explicitly removing a draft pill does not destroy the recovery entry. No unbounded undo history.

Export opens a native folder chooser in the desktop app, writes a newly named packet directory without overwriting unrelated files, and preserves active annotations and Undo. Cancelling or failing export changes no annotation state. A packet contains readable Markdown, versioned structured metadata, and original screenshot files with relative references. Identical saved annotations produce identical file contents and ordering; do not inject export-time timestamps or machine-specific paths. Browser mode may offer a deterministic ZIP of the identical packet through its native save/download affordance where folder writing is unavailable; this is an explicit platform capability, never a silent switch after a failed folder export.

## Chat attachment interaction

Place a plain plus icon at the far left of the existing bottom controls row, on the ordinary composer background, opposite Send. Keep it visible; unavailable composers expose a disabled control. It opens a multi-file chooser. File dropping onto the composer joins the same import path. Supported initial inputs are text/code files and PNG/JPEG/WebP/GIF images. PDFs, office documents, archives, audio/video, and arbitrary binary formats are deferred; reject unsupported types with a concise actionable error, never pretend that a filename delivers readable content.

Show attachments above the text box in one non-wrapping horizontal row, reusing the existing shared overflow fade primitive. Pills have a type icon, approximately 12–15 visible characters with ellipsis, full-name tooltip, and a separate remove x. Clicking the body opens a simple shared modal: bounded text preview, image preview, or annotation screenshot plus comment. Removing affects only this draft. Persist attachment order and draft ownership across navigation/restarts. Attachment-only messages are valid. Failed/uncertain submission retains the exact draft/attachment intent; retries must not duplicate attachments or messages. Accepted submissions clear only the submitted draft contents and retain the attachment bytes needed for conversation history and recovery.

## Delivery contract

Ordinary text/code attachment CONTENTS MUST NOT be automatically inserted into model context. Preserve the selected bytes in Mandible-owned attachment storage and send concise filenames plus agent-readable pointers to those retained copies. The agent decides whether and how much to read. Do not depend on the user's original path continuing to exist or changing content after attachment. A browser picker supplies bytes, not a trusted absolute path.

Image attachments and annotation screenshots use each supported provider's native image input (Codex App Server image/localImage; Claude structured image block), not literal base64 prose. Annotation COMMENT TEXT and concise element/page metadata are inserted directly into message context, never available only through a file pointer. Keep originals for history/preview/export. Use explicit adapter capabilities and fail visibly if a selected provider cannot deliver the requested attachment kind. Do not broaden sandbox permissions silently. Honor existing conversation ownership, preview isolation, outbox acknowledgement, idempotency, and transcript authority.

Use one shared discriminated attachment contract in src/conversation-control/attachments.ts. Proposed public shape, to be committed by the storage/delivery owner before consumers finish:

- StoredAttachmentFile: id, name, media_type, byte_length, sha256. IDs resolve to immutable server-custodied bytes; client paths never select arbitrary server files.
- ChatAttachment: kind=file|image with file: StoredAttachmentFile; or kind=annotation with id, ordinal, text, target (url, selector optional, element_text optional, rect, viewport, revision optional), and screenshot optional StoredAttachmentFile. Rectangle fields use x/y/width/height in CSS pixels.
- ConversationSubmitRequest carries attachments?: ChatAttachment[]. The server resolves and validates authoritative metadata and includes attachment identity/content in idempotency comparisons and persisted delivery intent.
- Authenticated POST /api/chat-attachments accepts {name, media_type, data_base64} and returns StoredAttachmentFile. GET /api/chat-attachments/:id/content returns retained bytes. Enforce explicit size/count bounds, file validation, and the existing local operator/preview access model. File RPC must not acquire a new unrestricted file-read route.
- UI API functions live in ui/src/chat/attachmentApi.ts: importAttachment(file: File): Promise<StoredAttachmentFile> and attachmentContentUrl(file): string. The composer owner implements these against the shared contract; the backend owner owns route registration.
- One UI state authority in ui/src/chat/attachmentDrafts.ts owns saved annotations, last-cleared recovery, and per-conversation draft attachments. The composer owner exposes annotation state/mutations and a currently visible writable Chat target; the annotator consumes it. Workers agree the exact exported API through the parent before implementing consumers. Paste and recovery transitions must be atomic in that authority.

## Work partition

Storage and delivery owns the shared attachment types, custody/upload/content routes, validation, conversation request/outbox changes, provider translation, and faithful history evidence. Composer owns the actual Chat composer in ui/src/views/conversations.tsx (not the old Console-only composer), its attachment/draft store and UI API, pills/modal/import, and submit plumbing in ui/src/api.ts. Annotator owns selection, pins/popovers, rail/strip integration, capture, deterministic export, and any required desktop capture/dialog bridge. Annotation state is consumed from the composer-owned store. Coordinate shared type or API changes before making parallel incompatible edits.

The parent owns specification, integration, and two persistent browser previews on separate branches. One uses the custom Mandible interface described above; the other uses Agentation's bundled toolbar, popovers, selection, and state behavior through a lean public-API adapter. Both share attachment custody, composer, typed payloads, and provider delivery. The Agentation preview retains recognizable upstream interaction and documents actual differences in persistence, routing, recovery, screenshots, and export rather than pretending to provide exact feature parity. Its Send behavior is defined below; it never sends an agent message directly. Failures and changed destinations preserve feedback.

For the Agentation comparison, Send targets the selected writable Chat even while another view is visible. It stages inline annotation text and element metadata, opens that Chat, and highlights newly added annotation pills blue with a fade lasting about one second. It does not submit the message. Keep upstream Agentation unchanged and preserve feedback on failure. Do not attempt screenshots or display the custom persistent status notification; optional annotation screenshots are deferred. A navbar control hides and shows Agentation. Hiding exits selection and removes the idle launcher; saved notes remain, but unfinished comment text may be discarded. Reopening may show the collapsed launcher. Layout remains unchanged. The custom annotator interaction specified above remains unchanged.

The user compares these first implementations before choosing how to proceed. Protected delivery and its production-daemon plus packaged-app candidate gate wait for that decision. Workers own bounded implementation and focused useful regression checks. No pushes or protected merges by workers. Use GPT-6 Sol at medium, user-visible tasks, no subagents. Every worker invokes begood and work-on-issues.

## Verification

Keep tests sparse at failure-prone boundaries: file custody and unsupported input rejection; exact provider payloads proving file contents are absent while annotation text/images are present; submission idempotency/recovery; durable Paste/Clear/Undo transitions and cross-chat isolation. One representative browser flow covers selection/save/edit/dismiss/reopen, Paste, pills/preview/removal, Undo, export cancellation/success, and overflowing pills. Avoid string/style snapshots and duplicated assertions across layers. Required repo gates remain required. Run late gates once after integration stabilizes, repeat only after relevant changes.

## Deferred

PDF and other rich-document interpretation is separate follow-up work. No in-app browser, arbitrary website injection, document review replacement, or provider UI reverse engineering belongs here. The two annotation interfaces are explicit comparison branches, not simultaneous competing state authorities in one running app. Verify Agentation's actual Preact compatibility and public API before calling its preview ready.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

# Interface annotations and attachments

The contract for annotating Mandible's own interface and for the attachments a Chat message carries. Three parts: the Chat attachment flow and the Agentation toolbar, which are delivered and stay as described; and interface notes, which keep a toolbar note from the moment it is saved and file it onto an issue for later work. The shared code contract for interface notes is `src/interface-notes/contract.ts`; this document explains it and does not restate its types.

## Chat attachments

The Chat composer accepts text/code files and PNG/JPEG/WebP/GIF images through a plus control at the left of the bottom controls row, through file drops anywhere in the conversation detail pane, and through annotation staging from the toolbar. PDFs, office documents, archives, audio/video and arbitrary binaries are rejected with a concise actionable error. Attachments show above the text box in one non-wrapping horizontal row: a pill with a type icon, a truncated label, a full-name tooltip and a separate remove control. Clicking a pill opens a bounded preview modal: text, image, or the annotation's text and element context. Drafts and their attachments are browser-local (`ui/src/chat/attachmentDrafts.ts`) until submitted; order and draft ownership survive navigation and restarts; attachment-only messages are valid; failed or uncertain submission retains the exact draft intent and a retry never duplicates attachments or messages.

Delivery (`src/conversation-control/attachment-delivery.ts`): file contents never enter model context; the agent gets the filename and a retained readable path and decides what to read. Images and annotation screenshots use each provider's native image input. Annotation text and concise element metadata are inserted into message context as text, in the one form `annotationAttachmentText` produces. Bytes live in Mandible custody (`POST /api/chat-attachments`, `GET /api/chat-attachments/:id/content`, `chat_attachment_files`), with explicit size and count bounds and the local operator access model.

One discriminated contract, `ChatAttachment` in `src/conversation-control/attachments.ts`, covers drafting, submission, persistence (`conversation_control_outbox.attachments_json`), provider delivery, preview, and now interface notes.

## Agentation toolbar

Mandible mounts the bundled Agentation 3.1.2 toolbar (`ui/src/annotation/`). A navbar control above Settings shows or hides it; the preference survives refresh. Selection, popovers, markers, Copy, Clear, Settings and keyboard shortcuts are the package's own. The custom Mandible annotator from the comparison is excluded from delivery; its remaining store functions and the comparison document's claims about shared routes are removed with [issue:0c7ad7a].

Facts about the package that bound the design, read from its source (`dist/index.mjs.map`) and confirmed in the running app:

- Notes are kept in `localStorage` under `feedback-annotations-<pathname>`, one set per URL path. `loadAnnotations` drops a note whose `timestamp` is older than seven days and keeps a note without one. Since Mandible routes by path, every view and entity page has its own set.
- A mounted toolbar reads its page's set only in the effect keyed on the pathname, which runs at mount and whenever the pathname it reads at render changes. It writes its own state back to that key on every change. Nothing else makes it re-read storage: no prop, no imperative handle, no storage-event listener.
- Pins are drawn only while the toolbar is expanded (`isActive`), and the expanded flag lives in the outermost component, so a keyed remount collapses the toolbar to its launcher.
- Pins are placed from the stored `x` (percent of window width) and `y` (document pixels) without finding the element again.
- `onAnnotationAdd`, `onAnnotationUpdate`, `onAnnotationDelete` and `onAnnotationsClear` fire for the user's actions in the toolbar only. Clear also fires for the automatic clear after Copy or Send when the user's `autoClearAfterCopy` setting is on.
- Send is shown when `onSubmit` is given and enabled only when the current page has at least one note. It awaits `onSubmit`, shows a sending state and disables itself while the promise is pending, then shows a sent or failed state for 2.5 seconds; a throw or rejection is the failed state. The callback receives the current page's notes.
- A note's id is `Date.now().toString()`; its editor refuses an empty comment.
- The toolbar does not support adding buttons, a fixed page key for the whole app, or forcing a clear after Send. No fork or patch of the package.

## Interface notes

### Terms

A note is one annotation made with the toolbar on Mandible's interface: its text, the element context of the shared attachment contract (`AnnotationTarget`, including the build revision of the page it was made on), and Agentation's own pin record. A note has one owner: none (unfiled) or one issue comment (filed). A page is a URL path of the app. The loaded issue is the one issue, if any, whose filed notes are currently shown as pins.

### Behaviour

**Notes are kept when made.** Adding, editing or deleting a note in the toolbar writes to the daemon at once. Unfiled notes reappear in every browser that opens the same instance, do not expire, and each pin is shown on the page where its note was made. A write that fails leaves the note in the toolbar and is retried at the next reconciliation; the rail control shows that writes are pending.

**Send.** The toolbar's Send opens one Mandible menu, which names how many unfiled notes it acts on (every page's, not only the current page's) and lists the destinations:

- the loaded issue, first and preselected, when there is one;
- New issue, which opens a title field prefilled with the first note's text; Enter files, Escape returns to the list;
- the open issues of the receiving project that carry notes, most recently annotated first;
- the selected writable Chat, which stages the notes on that draft as attachments and leaves them unfiled.

Choosing an issue files the notes as one new comment on it. Filing moves notes: a filed note is never copied to a second issue, and filed pins leave the toolbar. Dismissing the menu files nothing and settles Send in its failed state, which is the package's only way to show that nothing was sent. Without a receiving project the menu offers Chat only.

**The rail control.** The navbar Agentation control keeps its click (show or hide the toolbar). It shows the number of unfiled notes in the app, and its hover tip names the loaded issue. Its context menu is the same menu Send opens, so notes can be filed from a page that has none, and the loaded issue can be unloaded there.

**Issues.** An issue that carries notes is an ordinary issue: no special kind, no label, the ordinary open and closed lifecycle. An issue created from Send has kind `unknown` until an agent sets it, the given title, and an empty body; its notes are comment 1. The receiving project is the instance setting `interface_notes_project`, chosen on the Settings view from the registered projects.

A comment that carries notes shows them in the issue view as the pills Chat uses, each opening the same preview; its body text is not shown there, because it is the text form of the same notes. The remove control on a pill removes the note from the comment, and removing the last note soft-deletes the comment. The preview of a filed note has a pin action that loads the issue and opens the note's page.

**Agents.** The body of a comment that carries notes is the one text form Chat delivery gives an agent, `Annotation n: <text>` followed by the labelled context fields, one block per note, regenerated by the daemon on every change to the comment's notes. So `mandible issue show`, `mandible issue report`, issue search, the Markdown export, the Inbox and every other consumer of comment bodies show the notes without change, and a hand edit of such a body is refused. `mandible issue triage --notes` lists only issues that carry notes, most recently annotated first; the Send menu uses the same query.

**Loading an issue's notes.** The issue's header menu has Show pins, which loads the issue and opens the page of its first note, and Hide pins while it is loaded. One issue is loaded at a time; loading another replaces it. The loaded issue is browser view state and survives refresh. A loaded pin looks like any other pin; its hover card shows the note's text. While an issue is loaded:

- editing a loaded note's text edits the note on the issue, and the comment body's revision history records it;
- deleting a loaded pin, or Clear, removes it from the toolbar only; the issue is unchanged and the pin returns when the issue is loaded again;
- Send files only unfiled notes, with the loaded issue preselected.

### Mechanism

**Authority and cache.** The daemon holds every note. Agentation's local storage is a cache Mandible fills, one key per page, with the Agentation pin record of each note that belongs on that page (unfiled notes and the loaded issue's notes), its `comment` set from the note's text and its `timestamp` omitted. The toolbar reads a page's cache when it mounts and when the user navigates to the page, so a cache written while the user is elsewhere shows up without further action.

Reconciliation is one routine, run at boot before the toolbar mounts, after filing, on load and unload of an issue, and on the `interface_note:changed` event: fetch the unfiled notes and the loaded issue's notes, write every page's cache, remove cache keys for pages that have none, and remount the toolbar (a React `key` on the host) only when the current page's set changed by something other than this toolbar's own actions. The remount collapses the toolbar to its launcher; after filing that is the natural end of the action, and in the other cases the user expands it again. Changes made in another browser to a page the user is not on need no remount.

The toolbar's own writes to the cache (its state after each user action) and the daemon's record agree because every toolbar action is also a daemon write:

| toolbar callback | unfiled note | loaded (filed) note |
| --- | --- | --- |
| `onAnnotationAdd` | `POST /api/interface-notes` with id, text, target (from the existing adapter mapping, `revision` = `servedBackendGeneration()`), pin | not applicable |
| `onAnnotationUpdate` | `PATCH /api/interface-notes/:id {text}` | the same; the server revises the comment body |
| `onAnnotationDelete` | `DELETE /api/interface-notes/:id` | nothing |
| `onAnnotationsClear` | `DELETE` each unfiled note in the batch; notes the host has just filed are skipped | nothing |

Which column applies is the host's last knowledge of the note, and another browser may have filed it since. The daemon therefore decides the dangerous case: the plain `DELETE` deletes only an unfiled note and answers 409 `note_filed` otherwise, leaving the comment untouched; removing a filed note from its comment is a different call, `DELETE /api/interface-notes/:id?comment=<comment_id>`, which only the issue view makes. An edit needs no such guard: changing a note's text is what the user asked for whoever owns the note. When a response shows an owner the host did not expect (`note_filed`, or a patched note that comes back filed), the host reconciles.

Refusals are `{ error: <code>, message? }` with the codes and statuses of `INTERFACE_NOTE_ERRORS`; the browser surface throws `InterfaceNotesApiError { status, code }`. A failed write is recorded in browser storage as pending and replayed at the next reconciliation. A replay is done when it succeeds or when the daemon already holds, or has moved past, the state it asked for: `note_exists` on a create, `note_not_found` or `note_filed` on an edit or delete (`interfaceNoteWriteSettled`). Any other failure keeps it pending. Notes present in the toolbar's cache before this design (the user's existing notes) are uploaded once, at the first reconciliation on that browser, and a flag records that this migration ran; no other cache content is ever uploaded, so a note deleted elsewhere is never resurrected from a stale cache.

**Storage.** One table, in `src/db-baseline.ts` and a migration, classified for backup like `chat_attachment_files`:

```sql
CREATE TABLE interface_notes (
  id TEXT PRIMARY KEY,
  comment_id TEXT REFERENCES ledger_comments(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  target_json TEXT NOT NULL,
  pin_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_interface_notes_comment ON interface_notes(comment_id);
```

`comment_id NULL` is unfiled. Validation of text and target reuses the annotation validation now in `ChatAttachmentStore.resolve`, extracted so both callers share it; `pin_json` must be a JSON object whose `id` equals the row id. Notes within a comment are ordered by `created_at`; a note's ordinal is its 1-based position there, computed at read time. Revision history for filed notes is the comment body's: every regeneration is a `comment_body` revision with reason `edit` through the existing body-revision path. No new entity type and no new revision table. Full-text search covers notes because the body is indexed already.

**Comments that carry notes.** Filing runs in one transaction: resolve or create the issue, create the comment with body `renderInterfaceNotesBody(notes)` through the store's `addComment` (operator attribution from the request, source `mandible`), set `comment_id` on the listed notes that are still unfiled, and emit `ledger:comment:created` plus `interface_note:changed`. Text edits and removals of filed notes regenerate the body the same way; removing the last note sets the comment's `deleted_at`. Filing creates nothing when every listed note was filed or deleted meanwhile, and answers 409 `nothing_to_file`. `PATCH /api/ledger/comments/:id` with a `body` for a comment that carries notes returns 409 `comment_body_generated`.

**API.** Routes, payloads and the setting key are in `src/interface-notes/contract.ts`; browser calls go through `ui/src/annotation/interfaceNotesApi.ts`. All routes declare `ledger:read` or `ledger:write`, so a preview instance serves them against its own copy. `GET /api/issues?has_notes=true` filters each repo's issues to those that carry notes, adds `interface_notes: { count, last_at }` to each (a field on `GitBugIssue` in `src/types.ts`, present only on this query), and orders them by `last_at` descending; `cli/issue.sh` passes the query for `triage --notes`. The issue detail projection (`src/issue-detail-contract.ts`) gains `notes: InterfaceNote[]` on `LedgerIssueDetailComment` and on the comment timeline entry, in comment order. New issues created by filing go through the store's `createIssue` with kind `unknown`; the route is reachable only by the operator's browser identity, and the existing rule that an agent must give a concrete kind is untouched.

**Events.** `interface_note:changed` is added to the event allowlist in `src/contracts.ts` with the payload in the contract file. The UI's per-event cache switch invalidates the issue detail and issue list caches for it as it does for `ledger:` events.

**Settings.** `interface_notes_project` is an ordinary row in `settings`, read and written through the existing `GET /api/settings` and `PUT /api/settings/:key`. The Settings view shows it as a row with a `NativeSelect` over `listCanonicalProjects()`, with an empty choice.

**UI composition.** The pieces, and who may depend on what:

- `ui/src/components/shared/AttachmentPill.tsx`: `AttachmentPillRow` (the non-wrapping row inside `OverflowFade`) and `AttachmentPill({ attachment: ChatAttachment; highlighted?: boolean; onOpen(): void; onRemove?(): void; removeDisabled?: boolean })`, which derives its label (`Annotation n`, or the file name), icon and tooltip from the attachment. `AttachmentPreviewModal({ attachment: ChatAttachment | null; onClose(); actions?: JSX.Element })` wraps `DetailPaneModal` and renders `AnnotationPreviewContent` or the image or text preview. These replace the inline JSX and `conv-compose__attachment*` rules in `ui/src/views/conversations.tsx` and `ui/src/styles/conversations.css`; the classes move to `attachment-pill*` in their own stylesheet. The Chat composer and the issue comment card both use them; the comment card hides its body when the entry has notes and passes `interfaceNoteAttachment(note, ordinal)`.
- `ui/src/annotation/interfaceNotesStore.ts`: the browser's one authority for notes. It exposes a snapshot `{ ready, unfiled: InterfaceNote[], loadedIssue: { id, notes } | null, pendingWrites: number, epoch }` with `subscribe`, and the actions `reconcile()`, `setLoadedIssue(issueId | null)`, `recordAdd/Update/Delete/Clear` for the toolbar callbacks, and `markFiled(ids)`. The loaded issue is persisted with `usePersistedViewState`'s helpers under `mandible.agentation.loadedIssue:v1`; pending writes and the migration flag under `mandible.agentation.pending:v1` and `mandible.agentation.migrated:v1`.
- `ui/src/annotation/AgentationHost.tsx` replaces `AgentationPreview.tsx`: mounts `<Agentation key={epoch} appName="Mandible" ...callbacks onSubmit>` once the store is ready; `onSubmit` opens the menu and returns a promise the menu settles.
- `ui/src/annotation/InterfaceNotesMenu.tsx`: the Send menu, built on `useAnchoredMenu` and `app-anchored-menu`, anchored to the control that opened it: the toolbar's Send button, found by its accessible name `Send Annotations` inside the open shadow root of the `agentation-toolbar` element (stable for the pinned package), or the rail control. It takes the destinations from the store and the API, files through `fileInterfaceNotes`, stages to Chat through the existing adapter, then calls `markFiled` and `reconcile()`.
- `ui/src/annotation/AgentationToggleButton.tsx` gains the count, the hover tip and the context menu.
- Issue view: the header menu items Show pins and Hide pins call `setLoadedIssue`; the preview's pin action calls it and navigates with `navigateTo` to the note's page.

**Chat destination.** Staging to Chat takes the same set the menu names, in page then creation order, as `interfaceNoteAttachment` attachments, with the existing duplicate and 16-attachment checks of the adapter; the notes stay unfiled.

### Alternatives considered

- Agentation's `endpoint` sync protocol instead of callbacks and a cache. The daemon would host the package's sessions, annotation CRUD, health poll and event stream, and would need a class of browser write routes without the `x-mandible-csrf` header. Its gain is animated removal of filed pins and no remount after filing; it has no path for pushing a loaded issue's notes into the toolbar, so the remount would remain for loading. Not chosen.
- Comments with an empty body and the notes rendered by every consumer. Each consumer of comment bodies (UI, CLI show and report, search, export, Inbox, mirrors) would need the notes separately. The generated body gives all of them the one text form at no cost and keeps revision history on the existing path. Chosen.
- Notes owned by the issue body as well as by comments, so that a new issue's notes could be its description. The second owner type complicates every rule and conflicts with agents editing issue bodies. Comment-only ownership, empty body on a filing-created issue.
- Relying on the package's `autoClearAfterCopy` setting to clear filed pins. It is the user's setting, also affects Copy, and its clear is indistinguishable from the user's. The remount is used instead.

### Verification

Tests at the boundaries that can fail, in the gate: filing moves listed unfiled notes in one transaction, skips ones filed meanwhile, and regenerates the body; a text edit of a filed note produces a comment body revision; removing the last note soft-deletes the comment; a body edit of a carrying comment is refused; `has_notes` filtering and ordering; the migration converges. In the browser flow: a note survives clearing site data; a note older than seven days is shown; notes from two pages are filed together and their pins leave the toolbar; Show pins on an issue shows them on the right page, and Clear while loaded changes nothing on the issue; the Chat composer still renders and removes pills through the shared component. No string or style snapshots.

### Not in this contract

Notes made in a preview instance reach only the preview's own copy of the ledger. The mechanism for writing them to the source instance changes the preview effect policy and is decided with the user on [issue:346559a] before it is specified. Screenshots on notes are [issue:1e407c7]; the note record takes a `screenshot` file like the Chat annotation attachment when that lands. The Mandible skill's passage on how agents find and close out issues that carry notes is proposed to the dotfiles repository after delivery.

## Codex question replies

Only Codex conversations interpret the `send_user_message_question_reply` envelope as question-and-answer pairs. Render each question in the shared theme-aware muted text color used for tool entries, followed by its answer in normal user-message typography. Preserve ordering and full text. Do not apply this interpretation to other providers; malformed or unrelated content remains visible.

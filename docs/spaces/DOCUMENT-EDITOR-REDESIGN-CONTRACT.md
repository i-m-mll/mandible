# Spaces Document Editor Redesign Contract

Issue: ceb5963

## Problem

The current Spaces document editor presents Markdown through a collection of
block and line editors. It has accumulated special cases for headings, Enter,
focus restoration, and rendered click mapping, but still violates the user model:
the document should behave like one editable Markdown document, not like sealed
line or block islands.

## Source Of Truth

- Durable storage remains the existing `space_blocks` tree and C11 block API.
- Each editable prose block's `markdown` field stores the Markdown source text,
  including line breaks and inline reference syntax.
- The editor may compose editable prose blocks into a single interaction model,
  but it must not change C11 storage, C12 `spaces-doc.v1`, custody gating, SSE
  reconciliation, item embed/delete semantics, or the read-only renderer.
- Browser-local drafts remain local view state and must survive refetch/SSE
  reconciliation for live blocks.

## Presented Editor Model

- The primary user interaction surface is a text editor core over Markdown
  source, not a rendered block list with ad hoc textareas.
- Native editor semantics own typing, Enter, Backspace, arrow movement,
  selection, copy, paste, and caret retention.
- Mandible layers visual Markdown decorations on top of that source document.
  Decorations never become durable content and never define cursor behavior.

## Caret And Render Mapping

- The stored Markdown source is always the coordinate system for caret offsets.
- A Markdown scope may render typographically only when the selection/caret is
  outside that exact source range.
- When the selection/caret intersects a scope, the raw Markdown source for that
  scope is shown and edited.
- Heading scope is exactly one source line, from the opening hashes through the
  line break. Lines before and after the heading are separate editable text.
- Clicking a rendered heading maps into the heading line's source offsets,
  reveals that line's raw Markdown, and places the caret at the clicked source
  position.

## Enter And Backspace Semantics

- Enter inserts a newline at the current source selection and leaves the caret on
  the new line. It is not a block transition.
- Backspace on an empty line or at a line start removes/joins the newline using
  normal text-editor behavior.
- Pressing Enter after a Markdown heading can cause the heading line to render
  because the caret moved outside that line, but focus remains in the editable
  line below.

## Selection, Copy, And Paste

- Selection is editor-wide source selection. It must cross headings, prose, and
  inline refs without exposing implementation rows or line islands.
- Copy and paste operate on Markdown source text.
- The formatting toolbar is a transient overlay derived from a non-collapsed
  source selection.

## References And Commands

- Inline refs remain durable Markdown text such as `[issue:abc123]`.
- When the caret is outside a ref source range, refs render as compact dotted
  underlined labels. Clicking a rendered ref opens the shared bottom inspector.
- When the caret intersects a ref source range, the raw bracketed Markdown source
  is editable.
- Typed `/item` plus Enter opens the item picker and preserves the exact source
  range. Selecting an item replaces that command text with the durable bracketed
  reference.

## Viable Approaches Considered

1. Continue the line-region textarea model.
   - Rejected. It directly causes the current class of defects: focus loss,
     missing Backspace/newline join behavior, and per-line special cases.

2. Build a custom contenteditable document model.
   - Rejected for this pass. It would require a bespoke selection, IME,
     clipboard, paste, and decoration engine, which is exactly the risk this
     redesign should remove.

3. Use CodeMirror 6 as the editor core with Mandible-owned Markdown decorations.
   - Chosen. CodeMirror owns the text buffer and browser editing semantics while
     Mandible keeps storage, rendering contracts, inline refs, picker behavior,
     inspector behavior, autosave, custody gating, and tests.

## Out Of Scope

- No C11/C12 storage or grammar changes.
- No protected-branch merge, push, auth request, or integration preview merge.
- No direct ForumMagnum code copying.
- No full Markdown WYSIWYG system beyond heading-line and inline-reference
  source/display switching needed for this issue.
- No new block creation/reordering UX beyond preserving the existing first-block
  creation and embedded-item removal behavior.

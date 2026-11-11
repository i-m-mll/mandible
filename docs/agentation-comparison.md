# Agentation comparison preview

This branch mounts the bundled Agentation 3.1.2 toolbar in Mandible. Use its own selection, popovers, markers, Copy, Clear, and Settings controls. Its **Send to Agent** button stages one text-only annotation pill per saved note in the selected writable Chat draft, even when another view is visible. It navigates to that Chat and highlights only newly added pills blue for about one second. It does not submit a Chat message. Agentation's built-in Send failure state reports a rejected stage attempt.

## What the preview does

- A navbar control above Settings shows or hides Agentation. Hiding stops annotation input handling and removes the idle launcher; showing restores the collapsed launcher and saved notes. Unfinished comments are discarded on hide. The visibility preference survives refresh. Layout remains unchanged.
- Agentation keys its notes by `window.location.pathname`, and Mandible routes by path, so each view and entity page has its own set of notes and Send stages only the current page's. Its markers retain upstream behavior rather than Mandible's route-scoped anchoring. Mandible now keeps every note in the daemon and fills this per-page storage as a cache; see [interface annotations and attachments](specs/interface-annotations-and-attachments.md#interface-notes).
- Send appends to the selected writable Chat draft without requiring the Chat view to be visible. It leaves Agentation feedback intact on failure. A second Send of the same notes does not add duplicate pills to that draft. Existing draft text and attachments remain.
- Each pill carries the note's comment or selected text and concise element context directly. The selector is contextual evidence. No screenshot is captured or uploaded.
- Copy remains Agentation's own structured Markdown clipboard action.

## Differences to judge

| Action | Agentation preview | Custom Mandible annotator |
| --- | --- | --- |
| Persist notes | Agentation localStorage, one set per URL path, with its seven-day retention | Durable Mandible annotation draft across route changes and restarts |
| Paste into Chat | Bundled **Send to Agent** stages draft pills in the selected writable Chat and navigates there | **Paste** stages draft pills and moves the active set into one recovery entry |
| Clear and recovery | Bundled Clear removes notes; no one-set Undo. **Clear on copy/send** is off by default and can be enabled in Agentation Settings | Clear and successful Paste replace one recoverable set; Undo restores it beside newer notes |
| Export | Bundled Copy produces Markdown on the clipboard | Packet export preserves notes and writes Markdown, metadata, and original screenshots |
| Screenshot | None | Captured with the saved selection |

Agentation's current [API](https://www.agentation.com/api) documents `onSubmit` and hash-route storage; its [feature notes](https://www.agentation.com/features) state the seven-day local retention, no screenshots, React 18+ requirement, and bundled Clear/Copy controls. The installed package declares the PolyForm Shield 1.0.0 license. Review its terms before choosing it for lasting product delivery.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

# Agentation comparison preview

This branch mounts the bundled Agentation 3.1.2 toolbar in Mandible. Use its own selection, popovers, markers, Copy, Clear, and Settings controls. Its **Send to Agent** button stages one text-only annotation pill per saved note in the selected writable Chat draft, even when another view is visible. It navigates to that Chat and highlights only newly added pills blue for about one second. It does not submit a Chat message. Agentation's built-in Send failure state reports a rejected stage attempt.

## What the preview does

- A navbar control above Settings shows or hides Agentation. Hiding stops annotation input handling and removes the idle launcher; showing restores the collapsed launcher and saved notes. Unfinished comments are discarded on hide. The visibility preference survives refresh. Layout remains unchanged.
- Notes use Agentation's default app-path local storage, so they remain available when navigating from another Mandible view into Chat. Its markers retain upstream behavior rather than Mandible's route-scoped anchoring. The adapter does not copy them into Mandible's saved annotation store.
- Send appends to the selected writable Chat draft without requiring the Chat view to be visible. It leaves Agentation feedback intact on failure. A second Send of the same notes does not add duplicate pills to that draft. Existing draft text and attachments remain.
- Each pill carries the note's comment or selected text and concise element context directly. The selector is contextual evidence. No screenshot is captured or uploaded.
- Copy remains Agentation's own structured Markdown clipboard action.

## Differences to judge

| Action | Agentation preview | Custom Mandible annotator |
| --- | --- | --- |
| Persist notes | Agentation localStorage, shared across app hash routes, with its seven-day retention | Durable Mandible annotation draft across route changes and restarts |
| Paste into Chat | Bundled **Send to Agent** stages draft pills in the selected writable Chat and navigates there | **Paste** stages draft pills and moves the active set into one recovery entry |
| Clear and recovery | Bundled Clear removes notes; no one-set Undo. **Clear on copy/send** is off by default and can be enabled in Agentation Settings | Clear and successful Paste replace one recoverable set; Undo restores it beside newer notes |
| Export | Bundled Copy produces Markdown on the clipboard | Packet export preserves notes and writes Markdown, metadata, and original screenshots |
| Screenshot | None | Captured with the saved selection |

Agentation's current [API](https://www.agentation.com/api) documents `onSubmit` and hash-route storage; its [feature notes](https://www.agentation.com/features) state the seven-day local retention, no screenshots, React 18+ requirement, and bundled Clear/Copy controls. The installed package declares the PolyForm Shield 1.0.0 license. Review its terms before choosing it for lasting product delivery.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

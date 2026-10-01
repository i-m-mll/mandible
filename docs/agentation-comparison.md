# Agentation comparison preview

This branch mounts the bundled Agentation 3.1.2 toolbar in Mandible. Use its own selection, popovers, markers, Copy, Clear, and Settings controls. Its **Send to Agent** button stages one annotation pill per saved note in the currently visible writable Chat draft. It does not submit a Chat message. The small status notice reports stage failures and omitted screenshots.

## What the preview does

- Notes keep Agentation's hash-route-based local storage and marker behavior. The adapter does not copy them into Mandible's saved annotation store.
- Send captures the writable Chat at the start, checks it again before one durable draft append, and leaves Agentation feedback intact on failure. A second Send of the same notes does not add duplicate pills to that draft. Existing draft text and attachments remain.
- Each pill carries the note's comment or selected text and concise element context directly. The selector is contextual evidence. A screenshot is captured and uploaded at Send time only if the original single-element selector still resolves to the same visible bounds. Missing, moved, multi-element, area, or uncapturable targets yield a text-only pill and a visible omission count. Screenshots are thus current-target evidence, not saved-time snapshots.
- Copy remains Agentation's own structured Markdown clipboard action.

## Differences to judge

| Action | Agentation preview | Custom Mandible annotator |
| --- | --- | --- |
| Persist notes | Agentation localStorage, per hash route, with its seven-day retention | Durable Mandible annotation draft across route changes and restarts |
| Paste into Chat | Bundled **Send to Agent** stages draft pills; it requires an open writable Chat | **Paste** stages draft pills and moves the active set into one recovery entry |
| Clear and recovery | Bundled Clear removes notes; no one-set Undo. **Clear on copy/send** is off by default and can be enabled in Agentation Settings | Clear and successful Paste replace one recoverable set; Undo restores it beside newer notes |
| Export | Bundled Copy produces Markdown on the clipboard | Packet export preserves notes and writes Markdown, metadata, and original screenshots |
| Screenshot | Best-effort capture at Send time when a live single-element target matches | Captured with the saved selection |

Agentation's current [API](https://www.agentation.com/api) documents `onSubmit` and hash-route storage; its [feature notes](https://www.agentation.com/features) state the seven-day local retention, no screenshots, React 18+ requirement, and bundled Clear/Copy controls. The installed package declares the PolyForm Shield 1.0.0 license. Review its terms before choosing it for lasting product delivery.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

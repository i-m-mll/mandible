# App-shell right sidebar

Issues: `4fb8d9b`, `5096e37`

## Objective

Mandible has one right-edge detail surface owned by the app shell. Graph,
Timeline, Chat, and Console register controlled semantic content; they do not
own competing panel geometry.

## Shell contract

`AppRightSidebarDescriptor` is a discriminated union. A registration is either
one titled panel or a tabbed panel with one controlled active tab. The active
keep-alive route is the only route allowed to register.

The app shell owns:

- the full-height right edge, including a fixed header at the shared app-header
  height, a single scrolling body, a close action, and a left resize separator;
- browser-local open and width state through one scope-keyed helper;
- mouse and keyboard resizing, tab arrow/Home/End behavior, `aria-controls` and
  `aria-expanded`, and Escape close with focus restoration;
- responsive presentation. Wide windows show a resizable side-by-side column.
  Narrow windows show the same aside as the exclusive main-area pane and make
  the hidden rail and main content inert without changing their saved state.

`DetailPaneShell` remains the detail, overlay, and scroll composition authority
inside view-owned content. Canvas and document-editor inspectors, dialogs,
popovers, and modals remain local because they are not app-shell detail panes.

## View registrations

- Graph registers the selected-node detail as one titled panel.
- Timeline registers its inspector, including event, row, and cluster
  drilldown, as one titled panel. Selection opens it; refetch does not reset it.
- Chat registers Session Overview and Preview tabs. Overview is the default.
  Preview selection is local to the conversation. Changing conversation or
  clearing the selected preview returns to Overview.
- Console Rich Chat registers Session Settings and Message Info tabs.

The compact `DetailPaneHeader` accepts a final-actions slot so a sidebar toggle
can remain at the far right without displacing title, menu, or metadata. The
existing left `ViewSidebar` controls and state remain independent.

## Persistence and migration

`useAppRightSidebarState(scope)` stores `{ open, width }` in browser-local
storage. Graph migrates and removes its former open/height keys; Timeline
migrates its previous inspector fields into its project scope; Chat no longer
stores shelf visibility or tab state in authenticated user settings. Migration
171 removes any retained `chat_bottom_shelf` rows.

The sole link preference is the ordinary application setting
`chat_entity_link_action`, with values `preview` and `open`. Chat contains no
inline preference form. Plain activation follows the preference, the platform
modifier invokes the alternate action, and context-menu or keyboard-menu
actions always expose both choices with the wording “Preview in sidebar”.

## Removed design

`AppBottomPanel`, the rail-level bottom-panel toggle, height and layout
variants, private Graph/Timeline bottom geometry, Console's private right
sidebar, and `ChatBottomShelf` are superseded. Chat's transcript and anchored
composer remain in the main detail shell; no footer shelf participates in app
geometry.

## Verification

Focused shared-shell, Chat, Graph, Timeline, Console, settings, schema, UI
typecheck/build, and `git diff --check` provide the delivery evidence. Browser
preview and protected integration are coordinator-owned later gates.

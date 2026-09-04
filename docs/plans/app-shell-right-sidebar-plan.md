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
  height, a single scrolling body, and a left resize separator;
- one toggle rendered in one of two hosts. It is the rightmost sidebar-header
  item while open and the rightmost main-area-header item while closed. The
  icon is unchanged, `aria-pressed` reflects state, and focus follows it when
  the host changes;
- browser-local open and width state through one scope-keyed helper;
- pointer-capture and keyboard resizing against one effective min/max bound,
  icon-only tab controls with accessible labels and tooltips, tab
  arrow/Home/End behavior, and Escape close with focus restoration;
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
  clearing the selected preview returns to Overview. Both tabs share one
  18-pixel inline content frame and the shell body remains their only vertical
  scroll owner.
- Console Rich Chat registers Session Settings and Message Info tabs.

The compact `DetailPaneHeader` has no sidebar action slot. Sidebar controls are
shell-owned, so view headers cannot create a second control or overflow their
48-pixel boundary. The existing left `ViewSidebar` controls and state remain
independent.

Chat keeps only Run options, context usage, and Send in its composer footer.
Permission, model, reasoning effort, and provider-neutral extended controls use
one anchored Run options popover at every width. The popover is viewport-bound,
internally scrollable, dismisses on Escape or outside activation, and restores
focus to its trigger.

Conversation title-authority errors retain a machine code separately from the
human message. Deterministic missing provider metadata leaves a loaded
transcript and historical title visible without a futile Retry. Transient
provider unavailability offers Retry. Neither path silently invents a title.

## Persistence and migration

`useAppRightSidebarState(scope)` stores `{ open, width }` in browser-local
storage. Graph migrates and removes its former open/height keys; Timeline
migrates its previous inspector fields into its project scope; Chat no longer
stores shelf visibility or tab state in authenticated user settings. Migration
of former vertical geometry preserves only open state and uses the canonical
width default. Storage reads, writes, and one-shot legacy-key removal are
failure-contained so an unavailable browser store cannot reset in-memory user
intent.

Migration 171 translates the registered operator's schema-170
`chat_bottom_shelf.clickAction` into the canonical global
`chat_entity_link_action` setting before removing retained shelf rows. An
already-set canonical value wins. Migration 170 retains its exact historical
intermediate schema rather than borrowing the newer baseline definition.

The sole link preference is the ordinary application setting
`chat_entity_link_action`, with values `preview` and `open`. Chat contains no
inline preference form. Plain activation follows the preference, the platform
modifier invokes the alternate action, and context-menu or keyboard-menu
actions always expose both choices with the wording “Preview in sidebar”.

## Removed design

`AppBottomPanel`, the rail-level bottom-panel toggle, height and layout
variants, private Graph/Timeline bottom geometry, Console's private right
sidebar, `ChatBottomShelf`, view-owned sidebar toggles, the shell close-x, and
`DetailPaneHeader.finalActions` are superseded. Chat's transcript and anchored
composer remain in the main detail shell; no footer shelf participates in app
geometry.

## Verification

Focused shared-shell, Chat, Graph, Timeline, Console, settings, schema, UI
typecheck/build, the full default suite, and `git diff --check` provide delivery
evidence. The required real-Chromium `app-right-sidebar-geometry` gate mounts
the production shell and production Chat, Graph, Timeline, and Console content
at wide and narrow widths in light and dark themes. It proves the single-toggle
lifecycle, fixed header and sole body scroll owner, tabs, resize bounds,
persistence, narrow inertness, Chat composer geometry, Console tab stability,
and deterministic-versus-transient title presentation. Browser preview and
protected integration remain coordinator-owned later gates.

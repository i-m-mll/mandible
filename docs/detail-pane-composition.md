# Detail-pane composition

Use `DetailPaneShell` as the pane boundary and `DetailPaneHeader` as its `header`.
The shell owns one anchored header, one scrolling body, and an optional anchored
footer. The header owns identity, title, status, selection, metadata, and actions.

## Standard

```tsx
<DetailPaneShell
  header={(
    <DetailPaneHeader
      variant="standard"
      identity={{
        entityLabel: 'Issue',
        displayRef: issue.display_id,
        canonicalRef: `${issue.project.project_key}/${issue.display_id}`,
      }}
      title={issue.title}
      status={<StatusPill status={issue.status} />}
      actions={<IssueActionsMenu issue={issue} />}
    />
  )}
>
  <IssueBody issue={issue} />
</DetailPaneShell>
```

`displayRef` is the ambiguity-safe short value people scan. `canonicalRef` is
the full clipboard authority and is not rendered as fallback text.

## Compact

```tsx
<DetailPaneShell
  variant="compact"
  header={(
    <DetailPaneHeader
      variant="compact"
      identity={{
        entityLabel: 'Conversation',
        displayRef: conversation.display_id,
        canonicalRef: conversation.id,
      }}
      title={conversation.title}
      status={<AttachBadge state={conversation.attach_state} />}
      actions={<ConversationActions conversation={conversation} />}
    />
  )}
  footer={<Composer conversationId={conversation.id} />}
>
  <Transcript conversation={conversation} />
</DetailPaneShell>
```

The compact variant keeps the same semantics and native focus behavior while
constraining the title to one truncated line.

## Versioned entity

```tsx
<DetailPaneHeader
  variant="versioned"
  identity={{
    displayRef: artifact.short_hash,
    canonicalRef: `artifact-series:${artifact.series_id}`,
  }}
  title={artifact.title}
  state={version.is_latest ? <span>Latest</span> : undefined}
  selector={{
    label: 'Artifact version',
    control: (
      <select aria-label="Artifact version" value={version.id} onChange={selectVersion}>
        {versions.map((item) => <option value={item.id}>{item.label}</option>)}
      </select>
    ),
    selectedCanonicalRef: version.canonical_ref,
    copyLabel: 'Copy selected artifact-version reference',
  }}
  actions={<ArtifactActions artifact={artifact} />}
/>
```

The versioned variant has exactly two rows. Row one renders the optional entity
label plus bare ambiguity-safe hash and logical-entity copy at left, with the
subdued state, selector, and selected-reference copy at right. Row two renders
the title at left and actions at far right. Omitting `entityLabel` intentionally
removes the eyebrow/type prefix; the identity copy button remains labeled
`Copy full canonical reference`. The selector copy control always receives the
selected item's full typed canonical reference, never the logical parent ID or
visible option label.

## Review checklist

- Use exactly one `DetailPaneHeader` directly within the shell header slot.
- Keep actions, status, selector, and identity out of the scrolling body.
- Render an ambiguity-safe short ref; copy the full canonical ref.
- Keep one identity copy control and, when selecting versions, one selected-ref copy control.
- Give menus, selectors, and icon buttons keyboard-accessible names; retain visible focus.
- Verify long-title truncation, narrow widths, and coarse-pointer targets in every variant.
- Justify a bespoke composition by naming the missing contract capability first.

The Stage 1 structural test temporarily allowlists the existing Issue/Auth,
Artifact/Briefing, and Chat consumers. To avoid cross-worker conflicts, the
parent integrator removes those paths after all Stage 2 migrations compose
`DetailPaneHeader`.

Co-Authored-By: Codex (GPT-5) <codex@openai.com>

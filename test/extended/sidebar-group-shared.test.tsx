import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollectionsSidebar } from '../../ui/src/views/feedback/CollectionsSidebar.js';
import { SidebarGroupNode, SidebarNewChatIcon } from '../../ui/src/components/shared/SidebarGroupNode.js';
import type { SidebarReorderBinding } from '../../ui/src/components/shared/sidebar-order.js';
import { SettingsView } from '../../ui/src/views/settings.js';
import type { FeedbackCollection } from '../../ui/src/views/feedback/collection-model.js';
import * as api from '../../ui/src/api.js';

const sidebarGroupStylesheet = readFileSync('ui/src/styles/sidebar-group-node.css', 'utf8');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared sidebar group presentation', () => {
  it('keeps Briefing as the flat-list exception while reusing shared rows', () => {
    const briefing: FeedbackCollection = {
      id: 'briefing:one', collectionId: 'one', label: 'One', unansweredDirectiveCount: 2,
      latestRoundId: 'round-1', createdAt: 1, updatedAt: 2,
    };
    render(<CollectionsSidebar
      collections={[briefing]}
      confirmedLoaded
      selectedCollectionId={briefing.id}
      viewState={{
        collectionSourceFilter: '', pinnedOnly: true, collectionSort: 'activity', pinnedCollectionIds: [briefing.id],
        pinnedSectionCollapsed: true, collapsedBundleIds: [], collapsedGroupIds: [], collapsedGroupSubgroupKeys: [],
        selectedGroupUpdateIds: {}, selectedGroupId: null, selectedCollectionId: briefing.id, selectedRoundIds: {},
      }}
      setViewState={() => undefined}
      onSelect={() => undefined}
    />);

    const sidebar = screen.getByTestId('feedback-collections-sidebar');
    expect(screen.queryByRole('button', { name: /^Pinned/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /^Pinned/ })).toBeNull();
    expect(sidebar.querySelectorAll('.feedback-collections-sidebar__list')).toHaveLength(1);
    const row = screen.getByRole('button', { name: 'Select briefing One' })
      .closest('.feedback-collection-row');
    expect(row?.classList.contains('feedback-collection-row--pinned')).toBe(false);
    expect(row?.querySelector('.sidebar-item-row')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^(?:Pin|Unpin) One$/ })).toBeNull();
  });

  it('renders count-free aggregate headings and interaction-count metadata', () => {
    render(
      <>
        <SidebarGroupNode presentation="category" id="projects" label="Projects" expanded onToggle={() => undefined}>
          <SidebarGroupNode
            id="project-mandible"
            presentation="folder"
            leadingIcon={<span>F</span>}
            label="Mandible"
            count={12}
            countLabel="12 chats in Mandible"
            countVisibility="interaction"
            expanded
            onToggle={() => undefined}
          >
            <span>Leaf</span>
          </SidebarGroupNode>
        </SidebarGroupNode>
      </>,
    );

    const projects = screen.getByRole('button', { name: 'Projects' });
    expect(projects.querySelector('em')).toBeNull();
    expect(projects.closest('section')?.classList.contains('sidebar-group-node--category')).toBe(true);
    expect(projects.closest('section')?.classList.contains('sidebar-group-node--without-count')).toBe(true);
    const project = screen.getByRole('button', { name: /^Mandible/ });
    const projectSection = project.closest('section');
    expect(projectSection?.classList.contains('sidebar-group-node--folder')).toBe(true);
    expect(projectSection?.classList.contains('sidebar-group-node--with-icon')).toBe(true);
    expect(projectSection?.classList.contains('sidebar-group-node--interaction-count')).toBe(true);
    expect(screen.getByLabelText('12 chats in Mandible').textContent).toBe('12');
  });

  it('keeps a separate group action on its exact header line', () => {
    const onPress = vi.fn();
    const onToggle = vi.fn();
    render(
      <SidebarGroupNode
        presentation="category"
        id="chats"
        label="Chats"
        expanded
        onToggle={onToggle}
        action={{ label: 'New chat', icon: <SidebarNewChatIcon />, onPress }}
        testIds={{ root: 'chats-group', heading: 'chats-heading', action: 'chats-action' }}
      >
        <SidebarGroupNode presentation="folder" id="project" label="Project" leadingIcon={<span>F</span>} expanded onToggle={() => undefined} action={{ label: 'New project chat', icon: <SidebarNewChatIcon />, onPress: () => undefined }}>
          <span data-testid="descendant">Leaf</span>
        </SidebarGroupNode>
      </SidebarGroupNode>,
    );
    const heading = screen.getByRole('button', { name: 'Chats' });
    const action = screen.getByRole('button', { name: 'New chat' });
    expect(screen.getByTestId('chats-group').contains(heading)).toBe(true);
    expect(screen.getByTestId('chats-heading')).toBe(heading);
    expect(screen.getByTestId('chats-action')).toBe(action);
    expect(action).not.toBe(heading);
    expect(action.parentElement?.classList.contains('sidebar-group-node__action-slot')).toBe(true);
    expect(action.parentElement?.parentElement?.classList.contains('sidebar-group-node__header')).toBe(true);
    expect(screen.getByTestId('descendant').closest('.sidebar-group-node__header')).toBeNull();
    fireEvent.click(action);
    expect(onPress).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(action.closest('.sidebar-group-node__header') as HTMLElement);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(action.parentElement?.classList.contains('contextual-action-group')).toBe(true);
    expect(action.querySelector('[data-sidebar-action-icon="new-chat"]')).toBeTruthy();
    expect(action.parentElement?.parentElement?.classList.contains('contextual-action-owner')).toBe(true);
  });

  it('can keep an empty expanded group action visible without exposing it while folded', () => {
    const action = { label: 'Add project', icon: <span>+</span>, onPress: () => undefined, persistentWhenExpanded: true };
    const { rerender } = render(
      <SidebarGroupNode presentation="category" id="projects" label="Projects" expanded onToggle={() => undefined} action={action}>
        <span>No projects included</span>
      </SidebarGroupNode>,
    );

    expect(screen.getByRole('button', { name: 'Add project' }).parentElement?.classList.contains('contextual-action-group--persistent')).toBe(true);

    rerender(
      <SidebarGroupNode presentation="category" id="projects" label="Projects" expanded={false} onToggle={() => undefined} action={action}>
        <span>No projects included</span>
      </SidebarGroupNode>,
    );
    expect(screen.getByRole('button', { name: 'Add project' }).parentElement?.classList.contains('contextual-action-group--persistent')).toBe(false);
  });

  it('keeps a reorder grip contextual when its neighboring group action is persistent', () => {
    const reorder = {
      dragging: false,
      dropTarget: false,
      root: { 'data-sidebar-reorder-id': 'projects', onClickCapture: vi.fn() },
      control: {
        'aria-describedby': 'instructions status',
        'aria-keyshortcuts': 'Control+Shift+ArrowUp Control+Shift+ArrowDown',
        onKeyDown: vi.fn(),
      },
      handle: {
        'aria-label': 'Reorder Projects',
        'aria-describedby': 'instructions status',
        'aria-keyshortcuts': 'Control+Shift+ArrowUp Control+Shift+ArrowDown',
        'data-sidebar-reorder-handle': 'projects',
        onKeyDown: vi.fn(),
        onPointerDown: vi.fn(),
        onPointerMove: vi.fn(),
        onPointerUp: vi.fn(),
        onPointerCancel: vi.fn(),
        onLostPointerCapture: vi.fn(),
      },
    } satisfies SidebarReorderBinding;

    render(
      <SidebarGroupNode
        presentation="category"
        id="projects"
        label="Projects"
        expanded
        onToggle={() => undefined}
        reorder={reorder}
        action={{ label: 'Add project', icon: <span>+</span>, onPress: () => undefined, persistentWhenExpanded: true }}
      >
        <span>No projects included</span>
      </SidebarGroupNode>,
    );

    const gripGroup = screen.getByRole('button', { name: 'Reorder Projects' }).parentElement;
    const actionGroup = screen.getByRole('button', { name: 'Add project' }).parentElement;
    expect(gripGroup?.classList.contains('sidebar-group-node__reorder-slot')).toBe(true);
    expect(gripGroup?.classList.contains('contextual-action-group--persistent')).toBe(false);
    expect(actionGroup?.classList.contains('sidebar-group-node__action-slot')).toBe(true);
    expect(actionGroup?.classList.contains('contextual-action-group--persistent')).toBe(true);
    expect(gripGroup).not.toBe(actionGroup);
  });

  it('keeps a selectable group disclosure immediately after its heading content', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <SidebarGroupNode
        presentation="nested"
        id="briefing-group"
        label="Sara's skill, breakdown"
        expanded
        onToggle={onToggle}
        selection={{ selected: true, label: "Open Sara's skill, breakdown", onSelect }}
      >
        <span>Global policy</span>
      </SidebarGroupNode>,
    );

    const section = document.querySelector('.sidebar-group-node--selectable') as HTMLElement;
    const header = section.querySelector('.sidebar-group-node__header') as HTMLElement;
    const heading = section.querySelector('.sidebar-group-node__heading') as HTMLElement;
    const disclosure = section.querySelector('.sidebar-group-node__disclosure') as HTMLElement;
    expect(Array.from(header.children)).toEqual([heading, disclosure]);
    const headingRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node__heading \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(headingRule).toContain('flex: 0 1 auto');
    expect(headingRule).toContain('width: auto');
    expect(sidebarGroupStylesheet).toContain('.sidebar-group-node--expanded > .sidebar-group-node__header:hover > .sidebar-group-node__disclosure');
    expect(sidebarGroupStylesheet).not.toContain('.sidebar-group-node--expanded > .sidebar-group-node__header:is(:hover, :focus-within)');
    fireEvent.click(heading);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledOnce();
    fireEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('aligns category children and Show more to the heading text column without guide spines', () => {
    const categoryRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--category > \.sidebar-disclosure-region \{([^}]*)\}/,
    )?.[1] ?? '';
    const folderRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--folder > \.sidebar-disclosure-region \{([^}]*)\}/,
    )?.[1] ?? '';
    const showMoreRule = sidebarGroupStylesheet.match(/\.sidebar-group-node__show-more \{([^}]*)\}/)?.[1] ?? '';

    expect(categoryRule).toContain('--sidebar-title-column-inset: var(--sidebar-node-parent-inset)');
    expect(categoryRule).not.toContain('position: relative');
    expect(folderRule).toContain('calc(var(--sidebar-node-parent-inset) + var(--sidebar-node-icon-column))');
    expect(showMoreRule).toContain('var(--sidebar-title-column-inset, 7px)');
    expect(sidebarGroupStylesheet).not.toContain('.sidebar-group-node--category > .sidebar-disclosure-region::before');
  });

  it('gives no-icon structural nesting its own shared child inset', () => {
    render(
      <SidebarGroupNode presentation="nested" id="policy" label="Policy" expanded onToggle={() => undefined}>
        <span>Nested Briefing</span>
      </SidebarGroupNode>,
    );
    expect(screen.getByRole('button', { name: 'Policy' }).closest('section')?.classList.contains('sidebar-group-node--nested')).toBe(true);
    const nestedRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--nested > \.sidebar-disclosure-region \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(nestedRule).toContain('calc(var(--sidebar-node-parent-inset) + var(--sidebar-node-icon-column))');
    expect(sidebarGroupStylesheet).not.toContain('.sidebar-group-node--nested > .sidebar-disclosure-region::before');
  });

  it('shows and persists the default bounded Chat group size through generic settings', async () => {
    vi.spyOn(api, 'getInstructionDeliverySettings').mockResolvedValue({ targets: [], postExport: '' });
    vi.spyOn(api, 'listProjectsForPicker').mockResolvedValue([]);
    vi.spyOn(api, 'getBackupStatus').mockResolvedValue({} as Awaited<ReturnType<typeof api.getBackupStatus>>);
    vi.spyOn(api, 'getDelegatedSigningStatus').mockResolvedValue({
      provider: 'test', configured: false, public_key: null, public_key_path: '',
      encrypted_passphrase_path: '', recipient_path: '', missing_tools: [],
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const onSave = vi.fn(async () => undefined);
    render(<SettingsView settings={{}} onSave={onSave} />);

    const input = screen.getByRole('spinbutton', { name: 'Chats per group' }) as HTMLInputElement;
    expect(input.value).toBe('5');
    fireEvent.input(input, { target: { value: '80' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onSave).not.toHaveBeenCalledWith('conversations.sidebar_group_limit', '80');
    fireEvent.input(input, { target: { value: '50' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('conversations.sidebar_group_limit', '50'));
    expect(input.value).toBe('50');
    const keepAnnotations = screen.getByRole('switch', { name: 'Toggle Keep submitted annotations displayed' });
    expect(keepAnnotations.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(keepAnnotations);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('briefing.keep_submitted_annotations', 'true'));
  });
});

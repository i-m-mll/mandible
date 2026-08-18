import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollectionsSidebar } from '../ui/src/views/feedback/CollectionsSidebar.js';
import { SidebarGroupNode } from '../ui/src/components/shared/SidebarGroupNode.js';
import { SettingsView } from '../ui/src/views/settings.js';
import type { FeedbackCollection } from '../ui/src/views/feedback/collection-model.js';
import * as api from '../ui/src/api.js';

const sidebarGroupStylesheet = readFileSync('ui/src/styles/sidebar-group-node.css', 'utf8');
const sidebarItemStylesheet = readFileSync('ui/src/styles/sidebar-item-row.css', 'utf8');
const chatHistoryStylesheet = readFileSync('ui/src/styles/chat-history.css', 'utf8');
const tokenStylesheet = readFileSync('ui/src/styles/tokens.css', 'utf8');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared sidebar group presentation', () => {
  it('keeps Briefing as the flat-list exception while reusing shared rows', () => {
    const briefing: FeedbackCollection = {
      id: 'briefing:one', collectionId: 'one', label: 'One', itemCount: 2,
      latestRoundId: 'round-1', createdAt: 1, updatedAt: 2,
    };
    render(<CollectionsSidebar
      collections={[briefing]}
      selectedCollectionId={briefing.id}
      viewState={{
        collectionSourceFilter: '', pinnedCollectionIds: [briefing.id],
        pinnedSectionCollapsed: true, selectedCollectionId: briefing.id, selectedRoundIds: {},
      }}
      setViewState={() => undefined}
      onSelect={() => undefined}
    />);

    const sidebar = screen.getByTestId('feedback-collections-sidebar');
    expect(screen.queryByRole('button', { name: /^Pinned/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /^Pinned/ })).toBeNull();
    expect(sidebar.querySelectorAll('ul.feedback-collections-sidebar__list')).toHaveLength(1);
    const row = screen.getByRole('button', { name: 'Select briefing One' })
      .closest('.feedback-collection-row');
    expect(row?.classList.contains('feedback-collection-row--pinned')).toBe(true);
    expect(row?.querySelector('.sidebar-item-row')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Unpin One' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('supports count-free aggregate headings and stable interaction-only leaf counts', () => {
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
    const project = screen.getByRole('button', { name: /Mandible/ });
    const projectSection = project.closest('section');
    expect(projectSection?.classList.contains('sidebar-group-node--folder')).toBe(true);
    expect(projectSection?.classList.contains('sidebar-group-node--with-icon')).toBe(true);
    expect(projectSection?.classList.contains('sidebar-group-node--interaction-count')).toBe(true);
    expect(screen.getByLabelText('12 chats in Mandible').textContent).toBe('12');

    const countRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--interaction-count > \.sidebar-group-node__heading > \.sidebar-group-node__count \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(countRule).toContain('visibility: hidden');
    expect(countRule).toContain('opacity: 0');
    const revealRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--interaction-count > \.sidebar-group-node__heading:hover > \.sidebar-group-node__count,\s*\.sidebar-group-node--interaction-count > \.sidebar-group-node__heading:focus-visible > \.sidebar-group-node__count \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(revealRule).toContain('visibility: visible');
    expect(revealRule).not.toMatch(/display|width|grid-template-columns/);
    const countTypography = [...sidebarGroupStylesheet.matchAll(/\.sidebar-group-node__count \{([^}]*)\}/g)]
      .map((match) => match[1])
      .find((rule) => rule.includes('font-weight')) ?? '';
    expect(countTypography).toContain('font-weight: 400');
    expect(countTypography).toContain('color: var(--text-muted)');
    const folderGrid = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--with-icon > \.sidebar-group-node__heading \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(folderGrid).toContain('grid-template-columns: 16px minmax(0, 1fr) auto');
    const folderPreset = sidebarGroupStylesheet.match(/\.sidebar-group-node--folder \{([^}]*)\}/)?.[1] ?? '';
    expect(folderPreset).toContain('margin-bottom: 2px');
    const categoryHeading = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--category > \.sidebar-group-node__heading \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(categoryHeading).toContain('color: var(--text-subdued)');
    expect(tokenStylesheet).toContain('--text-subdued: var(--neutral-10);');
    const lightTheme = tokenStylesheet.match(/\[data-theme='light'\] \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(lightTheme).toContain('--text-subdued: var(--neutral-8);');
    const headingTypography = sidebarGroupStylesheet.match(
      /\.sidebar-group-node > \.sidebar-group-node__heading \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(headingTypography).toContain('font: 400 var(--text-md)/1.35 var(--font-sans)');
    const labelTypography = sidebarItemStylesheet.match(
      /\.sidebar-item-row__label \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(labelTypography).toContain('font-size: var(--text-md)');
    const strongTypography = sidebarGroupStylesheet.match(
      /\.sidebar-group-node__heading strong \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(strongTypography).toContain('font-weight: 400');
    const folderHeading = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--folder > \.sidebar-group-node__heading \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(folderHeading).toContain('color: var(--text-primary)');
    const rootColumn = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--category > :is\(div, ul\) \{([^}]*)\}/,
    )?.[1] ?? '';
    const folderColumn = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--folder > :is\(div, ul\) \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(rootColumn).toContain('--sidebar-title-column-inset: 7px');
    expect(folderColumn).toContain('--sidebar-title-column-inset: 29px');
    const showMoreRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node__show-more \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(showMoreRule).toContain('padding: 6px 7px 6px var(--sidebar-title-column-inset, 7px)');
    expect(showMoreRule).toContain('font-size: var(--text-md)');
    expect(chatHistoryStylesheet).not.toMatch(/chat-project-group__items[\s\S]*padding-left/);
    expect(sidebarGroupStylesheet).not.toMatch(/\.sidebar-group-node--without-count \.sidebar-group-node__heading/);
  });

  it('shows and persists the default bounded Chat group size through generic settings', async () => {
    vi.spyOn(api, 'getInstructionDeliverySettings').mockResolvedValue({ targets: [], postExport: '' });
    vi.spyOn(api, 'listProjectsForPicker').mockResolvedValue([]);
    vi.spyOn(api, 'getBackupStatus').mockResolvedValue({} as Awaited<ReturnType<typeof api.getBackupStatus>>);
    vi.spyOn(api, 'getRuntimeStatus').mockResolvedValue({} as Awaited<ReturnType<typeof api.getRuntimeStatus>>);
    vi.spyOn(api, 'getAuthAutoApproveStatus').mockResolvedValue({} as Awaited<ReturnType<typeof api.getAuthAutoApproveStatus>>);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const onSave = vi.fn(async () => undefined);
    render(<SettingsView settings={{}} onSave={onSave} />);

    const input = screen.getByRole('spinbutton', { name: 'Chats per group' }) as HTMLInputElement;
    expect(input.value).toBe('5');
    fireEvent.input(input, { target: { value: '80' } });
    fireEvent.click(input.parentElement?.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('conversations.sidebar_group_limit', '50'));
    expect(input.value).toBe('50');
  });
});

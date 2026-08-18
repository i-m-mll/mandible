import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollectionsSidebar } from '../ui/src/views/feedback/CollectionsSidebar.js';
import { SidebarGroupNode } from '../ui/src/components/shared/SidebarGroupNode.js';
import { SettingsView } from '../ui/src/views/settings.js';
import type { FeedbackCollection } from '../ui/src/views/feedback/collection-model.js';
import * as api from '../ui/src/api.js';

const sidebarGroupStylesheet = readFileSync('ui/src/styles/sidebar-group-node.css', 'utf8');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared sidebar group presentation', () => {
  it('renders Briefing Pinned through the normal-case shared heading', () => {
    const briefing: FeedbackCollection = {
      id: 'briefing:one', collectionId: 'one', label: 'One', itemCount: 2,
      latestRoundId: 'round-1', createdAt: 1, updatedAt: 2,
    };
    render(<CollectionsSidebar
      collections={[briefing]}
      selectedCollectionId={briefing.id}
      viewState={{
        collectionSourceFilter: '', pinnedCollectionIds: [briefing.id],
        pinnedSectionCollapsed: false, selectedCollectionId: briefing.id, selectedRoundIds: {},
      }}
      setViewState={() => undefined}
      onSelect={() => undefined}
    />);

    const heading = screen.getByRole('button', { name: /^Pinned/ });
    expect(heading.textContent).toContain('Pinned');
    expect(heading.classList.contains('sidebar-group-node__heading')).toBe(true);
    expect(heading.classList.contains('feedback-collections-sidebar__section-heading')).toBe(false);
  });

  it('supports count-free aggregate headings and stable interaction-only leaf counts', () => {
    render(
      <>
        <SidebarGroupNode id="projects" label="Projects" expanded onToggle={() => undefined}>
          <SidebarGroupNode
            id="project-mandible"
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
    expect(projects.closest('section')?.classList.contains('sidebar-group-node--without-count')).toBe(true);
    const project = screen.getByRole('button', { name: /Mandible/ });
    expect(project.closest('section')?.classList.contains('sidebar-group-node--interaction-count')).toBe(true);
    expect(screen.getByLabelText('12 chats in Mandible').textContent).toBe('12');

    const countRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--interaction-count \.sidebar-group-node__count \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(countRule).toContain('visibility: hidden');
    expect(countRule).toContain('opacity: 0');
    const revealRule = sidebarGroupStylesheet.match(
      /\.sidebar-group-node--interaction-count \.sidebar-group-node__heading:hover \.sidebar-group-node__count,\s*\.sidebar-group-node--interaction-count \.sidebar-group-node__heading:focus-visible \.sidebar-group-node__count \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(revealRule).toContain('visibility: visible');
    expect(revealRule).not.toMatch(/display|width|grid-template-columns/);
    const countTypography = [...sidebarGroupStylesheet.matchAll(/\.sidebar-group-node__count \{([^}]*)\}/g)]
      .map((match) => match[1])
      .find((rule) => rule.includes('font-weight')) ?? '';
    expect(countTypography).toContain('font-weight: 400');
    expect(countTypography).toContain('color: var(--text-muted)');
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

// AddToSpace — shared "Add to Space" affordance (umbrella de56ffa, child 08c312a).
//
// This is the single picker used by every surface that can contribute an item
// to a Space: issue detail (IssueDetail.tsx menu), artifact detail
// (artifacts.tsx header action) and the graph node detail (graph.tsx "send to
// Space"). It is deliberately a *picker*, not an editor: it lists the project's
// Spaces, lets the user choose one, and calls the C2 `addSpaceItem` route. It
// never opens/edits the Space canvas, so the graph stays a picker per §6.3.
//
// Per the project Dataful UX State rule, this component owns only transient
// browser-local view state (open/closed popover, the in-flight add). The
// canonical mutation (adding the item) is driven exclusively by an explicit
// user click, and Space membership is read back from the C2 API — never
// promoted from local state.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  addSpaceItem,
  listSpaces,
  listSpacesGrouped,
  type Space,
  type SpaceGroup,
  type SpaceItemRefType,
} from '../../api';
import './AddToSpace.css';

/**
 * One ref to contribute to a Space. Mirrors the `AddSpaceItemRequest` wire shape
 * (`ref_type`/`ref_id`/`ref_uri`/`title`) so callers pass exactly what the C2
 * route persists, with nothing surface-specific leaking into the contract.
 */
export type AddToSpaceTarget = {
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri?: string | null;
  title?: string | null;
};

export type AddToSpaceProps = {
  /** Project scope used to list candidate Spaces (`listSpaces`). */
  projectId: string | null | undefined;
  /** The ref(s) to add. Multiple targets (graph multi-select) add to the chosen Space in one pass. */
  targets: AddToSpaceTarget[];
  /**
   * Presentation:
   * - `button`  → standalone header/action button (artifact detail, graph pane).
   * - `menuitem` → a row inside an existing dropdown menu (issue actions menu).
   */
  variant?: 'button' | 'menuitem';
  /** Optional label override; defaults to "Add to Space". */
  label?: string;
  /** Disable the trigger (e.g. busy parent). The trigger also self-disables when there are no targets. */
  disabled?: boolean;
  /** Optional className passthrough for the trigger (so each surface can style it). */
  className?: string;
  /**
   * When true (default), the picker also lists Spaces from OTHER projects and the
   * top-level / global bucket — grouped by project, with the item's own project
   * first — so an item can be added to a cross-project or top-level Space. Set
   * false to keep the picker strictly single-project.
   *
   * NOTE: the backend cross-project membership enforcement (src/routes/spaces.ts)
   * currently rejects adding an item whose project differs from the Space's; the
   * backend child owns relaxing that. Offering the targets here is the UI half.
   */
  includeCrossProject?: boolean;
  /** Notified after a successful add so the host can surface a toast/refresh if it wants. */
  onAdded?: (space: Space, results: AddToSpaceResult[]) => void;
};

export type AddToSpaceResult = {
  target: AddToSpaceTarget;
  created: boolean;
  alreadyPresent: boolean;
};

/** One rendered section of the picker: a project (or top-level) and its spaces. */
type SpaceSection = { key: string; label: string; spaces: Space[] };

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; sections: SpaceSection[] }
  | { status: 'error'; message: string };

/**
 * Order the grouped sections so the item's own project comes first, then the
 * top-level / global bucket, then the remaining projects. A flat single-project
 * load (cross-project disabled) collapses to one unlabeled section.
 */
function buildSections(groups: SpaceGroup[], ownProjectId: string | null | undefined): SpaceSection[] {
  const own: SpaceSection[] = [];
  const top: SpaceSection[] = [];
  const rest: SpaceSection[] = [];
  for (const group of groups) {
    if (group.spaces.length === 0) continue;
    const section: SpaceSection = {
      key: group.project_id ?? '__top_level__',
      label: group.project_id === null ? 'Top level' : group.project_name ?? 'Project',
      spaces: group.spaces,
    };
    if (group.project_id && ownProjectId && group.project_id === ownProjectId) own.push(section);
    else if (group.project_id === null) top.push(section);
    else rest.push(section);
  }
  return [...own, ...top, ...rest];
}

export function AddToSpace({
  projectId,
  targets,
  variant = 'button',
  label = 'Add to Space',
  disabled = false,
  className,
  includeCrossProject = true,
  onAdded,
}: AddToSpaceProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [pendingSpaceId, setPendingSpaceId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasTargets = targets.length > 0;
  const triggerDisabled = disabled || !projectId || !hasTargets;

  // Lazily load Spaces the first time the popover opens (and re-load if the
  // project changes between opens). Backend refreshes are reconciliation inputs;
  // we only fetch on the explicit open action. When cross-project is enabled we
  // read the grouped list (own project + top-level + other projects); otherwise
  // we keep the strict single-project read.
  useEffect(() => {
    if (!open || !projectId) return undefined;
    let active = true;
    setLoad({ status: 'loading' });
    const loader = includeCrossProject
      ? listSpacesGrouped().then((groups) => buildSections(groups, projectId))
      : listSpaces(projectId).then((spaces) => (
        spaces.length > 0 ? [{ key: projectId, label: '', spaces }] : []
      ));
    loader
      .then((sections) => {
        if (active) setLoad({ status: 'ready', sections });
      })
      .catch((error: unknown) => {
        if (active) {
          setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [open, projectId, includeCrossProject]);

  // Close on outside pointer / Escape, matching the issue-actions menu behavior.
  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const node = containerRef.current;
      if (!node || node.contains(event.target as Node)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  const toggle = () => {
    if (triggerDisabled) return;
    setFeedback(null);
    setOpen((prev) => !prev);
  };

  const addToSpace = async (space: Space) => {
    if (pendingSpaceId) return;
    setPendingSpaceId(space.id);
    setFeedback(null);
    try {
      const results: AddToSpaceResult[] = [];
      for (const target of targets) {
        const response = await addSpaceItem(space.id, {
          ref_type: target.ref_type,
          ref_id: target.ref_id,
          ref_uri: target.ref_uri ?? null,
          title: target.title ?? null,
        });
        results.push({
          target,
          created: response.created,
          alreadyPresent: response.already_present,
        });
      }
      const added = results.filter((result) => result.created).length;
      const present = results.filter((result) => result.alreadyPresent).length;
      setFeedback(summarizeOutcome(space.title, added, present));
      onAdded?.(space, results);
      setOpen(false);
    } catch (error: unknown) {
      setFeedback(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPendingSpaceId(null);
    }
  };

  const triggerClass = [
    variant === 'menuitem' ? 'add-to-space__trigger--menuitem' : 'add-to-space__trigger--button',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const readySectionCount = useMemo(
    () => (load.status === 'ready' ? load.sections.reduce((n, s) => n + s.spaces.length, 0) : 0),
    [load],
  );

  return (
    <div className="add-to-space" ref={containerRef} data-testid="add-to-space">
      <button
        type="button"
        className={`add-to-space__trigger ${triggerClass}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={triggerDisabled}
        title={!projectId ? 'No project context for Spaces' : !hasTargets ? 'Nothing to add' : label}
        role={variant === 'menuitem' ? 'menuitem' : undefined}
        onClick={toggle}
      >
        {label}
        {targets.length > 1 ? ` (${targets.length})` : ''}
      </button>
      {open && (
        <div className="add-to-space__popover" role="menu" data-testid="add-to-space-popover">
          {load.status === 'loading' && (
            <div className="add-to-space__status">Loading Spaces…</div>
          )}
          {load.status === 'error' && (
            <div className="add-to-space__status add-to-space__status--error">{load.message}</div>
          )}
          {load.status === 'ready' && readySectionCount === 0 && (
            <div className="add-to-space__status">No Spaces yet.</div>
          )}
          {load.status === 'ready' &&
            load.sections.map((section) => (
              <div key={section.key} className="add-to-space__section" data-testid={`add-to-space-section-${section.key}`}>
                {section.label ? (
                  <div className="add-to-space__section-label">{section.label}</div>
                ) : null}
                {section.spaces.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    className="add-to-space__option"
                    role="menuitem"
                    disabled={pendingSpaceId !== null}
                    onClick={() => void addToSpace(space)}
                  >
                    <span className="add-to-space__option-title">{space.title}</span>
                    {pendingSpaceId === space.id && <span className="add-to-space__option-busy">adding…</span>}
                  </button>
                ))}
              </div>
            ))}
        </div>
      )}
      {feedback && (
        <div className="add-to-space__feedback" role="status" data-testid="add-to-space-feedback">
          {feedback}
        </div>
      )}
    </div>
  );
}

function summarizeOutcome(spaceTitle: string, added: number, present: number): string {
  if (added > 0 && present > 0) {
    return `Added ${added} to ${spaceTitle} (${present} already present)`;
  }
  if (added > 0) {
    return `Added ${added === 1 ? 'item' : `${added} items`} to ${spaceTitle}`;
  }
  if (present > 0) {
    return `Already in ${spaceTitle}`;
  }
  return `Added to ${spaceTitle}`;
}

export default AddToSpace;

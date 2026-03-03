import { useEffect, useRef, useState } from 'preact/hooks';

// --- Types ---

export interface PairingHooks {
  hook_setup?: string;
  hook_teardown?: string;
}

export interface HookTemplate {
  id: string;
  name: string;
  hook_setup?: string;
  hook_teardown?: string;
  builtin?: boolean;
}

export interface SwitchboardPairing {
  name: string;
  source: string;
  target: string;
  hook_setup?: string;
  hook_teardown?: string;
}

export interface SwitchboardItem {
  name: string;
  state: 'linked' | 'unlinked' | 'broken' | 'conflict';
  is_dir: boolean;
}

interface SwitchboardViewProps {
  pairings: SwitchboardPairing[];
  selectedPairing: string | null;
  items: SwitchboardItem[];
  itemsLoading: boolean;
  consistencyErrors?: Array<{ item: string; error: string }>;
  templates: HookTemplate[];
  onSelectPairing: (name: string | null) => void;
  onAddPairing: (name: string, source: string, target: string, hooks?: PairingHooks) => Promise<void>;
  onUpdatePairing: (name: string, source: string, target: string, hooks?: PairingHooks) => Promise<void>;
  onDeletePairing: (name: string) => Promise<void>;
  onToggleItem: (pairingName: string, item: string) => Promise<void>;
  onSync: (pairingName: string) => Promise<void>;
  onSaveTemplate: (name: string, hookSetup: string, hookTeardown: string) => Promise<void>;
}

// --- Helpers ---

function abbreviatePath(p: string): string {
  // Replace common prefix patterns
  const parts = p.split('/');
  if (parts.length > 4) {
    return '…/' + parts.slice(-3).join('/');
  }
  return p;
}

function stateIcon(state: SwitchboardItem['state']): string {
  switch (state) {
    case 'linked': return '⚡';
    case 'unlinked': return '○';
    case 'broken': return '⚠';
    case 'conflict': return '✕';
  }
}

function stateColor(state: SwitchboardItem['state']): string {
  switch (state) {
    case 'linked': return 'var(--accent-green)';
    case 'unlinked': return 'var(--text-muted)';
    case 'broken': return 'var(--accent-red)';
    case 'conflict': return 'var(--accent-yellow)';
  }
}

function stateFontWeight(state: SwitchboardItem['state']): string {
  return state === 'linked' ? '600' : '400';
}

const inputStyle = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '6px',
  padding: '6px 10px',
  color: 'var(--text-primary)',
  fontSize: '13px',
  width: '100%',
};

// --- Component ---

export function SwitchboardView({
  pairings,
  selectedPairing,
  items,
  itemsLoading,
  consistencyErrors,
  templates,
  onSelectPairing,
  onAddPairing,
  onUpdatePairing,
  onDeletePairing,
  onToggleItem,
  onSync,
  onSaveTemplate,
}: SwitchboardViewProps): JSX.Element {
  // Form state — used for both Add and Edit modes
  const [formName, setFormName] = useState('');
  const [formSource, setFormSource] = useState('');
  const [formTarget, setFormTarget] = useState('');
  const [formHookSetup, setFormHookSetup] = useState('');
  const [formHookTeardown, setFormHookTeardown] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formInFlight, setFormInFlight] = useState(false);

  // Template selector state
  const DEFAULT_TEMPLATE_ID = 'mll-bio-draft';
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);

  const [syncInFlight, setSyncInFlight] = useState(false);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pendingItems, setPendingItems] = useState<Set<string>>(new Set());

  // Ellipsis dropdown: which pairing's menu is open (null = none)
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const selected = pairings.find((p) => p.name === selectedPairing) ?? null;
  const isEditMode = selectedPairing !== null;

  // When selection changes, populate form with current values (or reset for add mode)
  useEffect(() => {
    if (selected) {
      setFormName(selected.name);
      setFormSource(selected.source);
      setFormTarget(selected.target);
      setFormHookSetup(selected.hook_setup ?? '');
      setFormHookTeardown(selected.hook_teardown ?? '');
      // Default-select the mll.bio template if no hooks are set yet
      if (!selected.hook_setup && !selected.hook_teardown) {
        setSelectedTemplateId(DEFAULT_TEMPLATE_ID);
      } else {
        setSelectedTemplateId('');
      }
    } else {
      setFormName('');
      setFormSource('');
      setFormTarget('');
      setFormHookSetup('');
      setFormHookTeardown('');
      setSelectedTemplateId(DEFAULT_TEMPLATE_ID);
    }
    setFormError(null);
    setAdvancedOpen(false);
  }, [selectedPairing]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!openDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openDropdown]);

  const handleApplyTemplate = () => {
    if (!selectedTemplateId) return;
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl) return;
    setFormHookSetup(tpl.hook_setup ?? '');
    setFormHookTeardown(tpl.hook_teardown ?? '');
  };

  const handleSaveAsTemplate = async () => {
    const name = window.prompt('Template name:');
    if (!name || !name.trim()) return;
    try {
      await onSaveTemplate(name.trim(), formHookSetup, formHookTeardown);
    } catch (err) {
      window.alert(`Failed to save template: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleFormSubmit = async () => {
    if (!formSource.trim() || !formTarget.trim()) {
      setFormError('Source and target are required');
      return;
    }
    setFormInFlight(true);
    setFormError(null);
    const hooks: PairingHooks = {};
    if (formHookSetup.trim()) hooks.hook_setup = formHookSetup.trim();
    if (formHookTeardown.trim()) hooks.hook_teardown = formHookTeardown.trim();
    try {
      if (isEditMode && selectedPairing) {
        await onUpdatePairing(selectedPairing, formSource.trim(), formTarget.trim(), hooks);
      } else {
        if (!formName.trim()) {
          setFormError('Name is required');
          setFormInFlight(false);
          return;
        }
        await onAddPairing(formName.trim(), formSource.trim(), formTarget.trim(), hooks);
        setFormName('');
        setFormSource('');
        setFormTarget('');
        setFormHookSetup('');
        setFormHookTeardown('');
        setAdvancedOpen(false);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setFormInFlight(false);
    }
  };

  const handleDeleteWithConfirm = async (name: string) => {
    setOpenDropdown(null);
    if (!window.confirm(`Delete pairing "${name}"?`)) return;
    await onDeletePairing(name);
  };

  const handleToggle = async (itemName: string, state: SwitchboardItem['state']) => {
    if (state === 'conflict') {
      setToggleError(`Cannot toggle "${itemName}": a real file exists at the target path. Resolve manually.`);
      return;
    }
    if (!selectedPairing) return;
    if (pendingItems.has(itemName)) return;
    setToggleError(null);
    setPendingItems((prev) => new Set(prev).add(itemName));
    try {
      await onToggleItem(selectedPairing, itemName);
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingItems((prev) => {
        const next = new Set(prev);
        next.delete(itemName);
        return next;
      });
    }
  };

  const handleSync = async () => {
    if (!selectedPairing) return;
    setSyncInFlight(true);
    setSyncErrors([]);
    try {
      await onSync(selectedPairing);
    } catch (err) {
      setSyncErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSyncInFlight(false);
    }
  };

  // Count by state for summary
  const stateCounts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.state] = (acc[item.state] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: 'flex', gap: '24px', height: 'calc(100vh - 140px)' }}>
      {/* Left panel: pairings list */}
      <div style={{
        width: '280px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        <div className="view-header" style={{ marginBottom: '8px' }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>Switchboard</h2>
        </div>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}>
          {pairings.length === 0 ? (
            <div className="text-muted" style={{ padding: '12px 0', fontSize: '13px' }}>
              No pairings yet. Add one below.
            </div>
          ) : (
            pairings.map((pairing) => {
              const isSelected = pairing.name === selectedPairing;
              const isDropdownOpen = openDropdown === pairing.name;

              return (
                <div
                  key={pairing.name}
                  style={{ position: 'relative' }}
                  className="pairing-item-wrapper"
                >
                  <button
                    type="button"
                    onClick={() => onSelectPairing(isSelected ? null : pairing.name)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      paddingRight: '36px',
                      background: isSelected
                        ? 'var(--bg-card)'
                        : 'rgba(255,255,255,0.03)',
                      border: '1px solid',
                      borderColor: isSelected
                        ? 'rgba(77,163,255,0.3)'
                        : 'rgba(255,255,255,0.05)',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      color: 'var(--text-primary)',
                      textAlign: 'left',
                      width: '100%',
                      gap: '8px',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontWeight: 500,
                        fontSize: '14px',
                        color: isSelected ? 'var(--accent-blue)' : 'var(--text-primary)',
                        marginBottom: '4px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {pairing.name}
                      </div>
                      <div style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {abbreviatePath(pairing.source)} → {abbreviatePath(pairing.target)}
                      </div>
                    </div>
                  </button>

                  {/* Ellipsis button — visible only on hover via CSS */}
                  <div
                    ref={isDropdownOpen ? dropdownRef : undefined}
                    style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)' }}
                  >
                    <button
                      type="button"
                      className="pairing-ellipsis-btn"
                      title="More options"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenDropdown(isDropdownOpen ? null : pairing.name);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: '4px 6px',
                        fontSize: '16px',
                        lineHeight: 1,
                        borderRadius: '4px',
                        opacity: isDropdownOpen ? 1 : undefined,
                      }}
                    >
                      ⋯
                    </button>

                    {isDropdownOpen && (
                      <div style={{
                        position: 'absolute',
                        right: 0,
                        top: '100%',
                        marginTop: '4px',
                        background: 'var(--bg-card)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        padding: '4px',
                        zIndex: 100,
                        minWidth: '140px',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                      }}>
                        <button
                          type="button"
                          onClick={() => handleDeleteWithConfirm(pairing.name)}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            background: 'none',
                            border: 'none',
                            color: 'var(--accent-red)',
                            cursor: 'pointer',
                            padding: '6px 10px',
                            fontSize: '13px',
                            borderRadius: '5px',
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(242,107,107,0.1)';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.background = 'none';
                          }}
                        >
                          Delete pairing
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Add / Edit pairing form */}
        <div style={{
          background: 'var(--bg-card)',
          borderRadius: '12px',
          padding: '14px',
          border: '1px solid rgba(255,255,255,0.05)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {isEditMode ? 'Edit Pairing' : 'Add Pairing'}
          </div>

          {/* Name field: read-only in edit mode, editable in add mode */}
          <input
            type="text"
            placeholder="Name"
            value={formName}
            disabled={isEditMode}
            onInput={(e) => setFormName(e.currentTarget.value)}
            style={{
              ...inputStyle,
              opacity: isEditMode ? 0.5 : 1,
              cursor: isEditMode ? 'default' : undefined,
            }}
          />
          <input
            type="text"
            placeholder="Source directory"
            value={formSource}
            onInput={(e) => setFormSource(e.currentTarget.value)}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
          />
          <input
            type="text"
            placeholder="Target directory"
            value={formTarget}
            onInput={(e) => setFormTarget(e.currentTarget.value)}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
          />

          {/* Advanced: lifecycle hooks */}
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '11px',
              padding: '2px 0',
              textAlign: 'left',
              letterSpacing: '0.03em',
            }}
          >
            {advancedOpen ? '▾' : '▸'} Advanced
          </button>

          {advancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {/* Template selector row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>Template:</div>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.currentTarget.value)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '6px',
                    padding: '4px 8px',
                    color: 'var(--text-primary)',
                    fontSize: '12px',
                  }}
                >
                  <option value="">— select a template —</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}{tpl.builtin ? ' (built-in)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleApplyTemplate}
                  disabled={!selectedTemplateId}
                  style={{
                    background: 'rgba(77,163,255,0.15)',
                    border: '1px solid rgba(77,163,255,0.3)',
                    borderRadius: '5px',
                    color: 'var(--accent-blue)',
                    cursor: selectedTemplateId ? 'pointer' : 'not-allowed',
                    fontSize: '11px',
                    padding: '4px 8px',
                    flexShrink: 0,
                    opacity: selectedTemplateId ? 1 : 0.5,
                  }}
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={handleSaveAsTemplate}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '5px',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: '11px',
                    padding: '4px 8px',
                    flexShrink: 0,
                  }}
                >
                  Save as template…
                </button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>On link (setup hook)</div>
              <textarea
                placeholder="Shell command run after linking an item"
                value={formHookSetup}
                onInput={(e) => setFormHookSetup(e.currentTarget.value)}
                rows={3}
                style={{
                  ...inputStyle,
                  fontFamily: 'monospace',
                  resize: 'vertical',
                  minHeight: '56px',
                }}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>On unlink (teardown hook)</div>
              <textarea
                placeholder="Shell command run after unlinking an item"
                value={formHookTeardown}
                onInput={(e) => setFormHookTeardown(e.currentTarget.value)}
                rows={3}
                style={{
                  ...inputStyle,
                  fontFamily: 'monospace',
                  resize: 'vertical',
                  minHeight: '56px',
                }}
              />
            </div>
          )}

          {formError && (
            <div style={{ fontSize: '12px', color: 'var(--accent-red)' }}>{formError}</div>
          )}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn"
              disabled={formInFlight}
              onClick={handleFormSubmit}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {formInFlight
                ? (isEditMode ? 'Updating…' : 'Adding…')
                : (isEditMode ? 'Update Pairing' : 'Add')}
            </button>
            {isEditMode && (
              <button
                type="button"
                onClick={() => onSelectPairing(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '13px',
                  padding: '6px 4px',
                  textDecoration: 'underline',
                  flexShrink: 0,
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Right panel: items */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {!selectedPairing ? (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div className="text-muted" style={{ textAlign: 'center' }}>
              Select a pairing to view and manage its items
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
              <div>
                <h2 style={{ margin: '0 0 4px', fontSize: '18px' }}>{selected?.name ?? selectedPairing}</h2>
                {selected && (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {selected.source} → {selected.target}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn"
                disabled={syncInFlight}
                onClick={handleSync}
                style={{ flexShrink: 0 }}
              >
                {syncInFlight ? 'Syncing…' : 'Sync'}
              </button>
            </div>

            {syncErrors.length > 0 && (
              <div style={{
                background: 'rgba(242,107,107,0.1)',
                border: '1px solid rgba(242,107,107,0.2)',
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '13px',
                color: 'var(--accent-red)',
              }}>
                <strong>Sync errors:</strong>
                <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px' }}>
                  {syncErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {toggleError && (
              <div style={{
                background: 'rgba(245,194,92,0.1)',
                border: '1px solid rgba(245,194,92,0.2)',
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '13px',
                color: 'var(--accent-yellow)',
              }}>
                {toggleError}
              </div>
            )}

            {/* Items list */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              background: 'var(--bg-card)',
              borderRadius: '14px',
              border: '1px solid rgba(255,255,255,0.04)',
              display: 'flex',
              flexDirection: 'column',
            }}>
              {itemsLoading ? (
                <div style={{ padding: '32px', textAlign: 'center' }} className="text-muted">
                  Loading…
                </div>
              ) : items.length === 0 ? (
                <div style={{ padding: '32px', textAlign: 'center' }} className="text-muted">
                  No items in source directory
                </div>
              ) : (
                items.map((item) => {
                    const isPending = pendingItems.has(item.name);
                    return (
                      <button
                        key={item.name}
                        type="button"
                        onClick={() => handleToggle(item.name, item.state)}
                        disabled={isPending}
                        title={
                          isPending
                            ? 'Working…'
                            : item.state === 'conflict'
                            ? 'Conflict: real file exists at target. Cannot toggle.'
                            : `Click to ${item.state === 'linked' ? 'unlink' : 'link'}`
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '10px 16px',
                          background: 'none',
                          border: 'none',
                          borderBottom: '1px solid rgba(255,255,255,0.04)',
                          cursor: isPending || item.state === 'conflict' ? 'not-allowed' : 'pointer',
                          textAlign: 'left',
                          width: '100%',
                          color: isPending ? 'var(--text-muted)' : stateColor(item.state),
                          fontWeight: stateFontWeight(item.state),
                          fontSize: '14px',
                          fontFamily: 'var(--font-mono)',
                          transition: 'background 0.15s ease',
                          opacity: isPending ? 0.6 : 1,
                        }}
                        onMouseEnter={(e) => {
                          if (!isPending && item.state !== 'conflict') {
                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
                          }
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLButtonElement).style.background = 'none';
                        }}
                      >
                        <span style={{ width: '18px', textAlign: 'center', flexShrink: 0 }}>
                          {isPending ? '…' : stateIcon(item.state)}
                        </span>
                        <span style={{ flex: 1 }}>
                          {item.name}{item.is_dir ? '/' : ''}
                        </span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>
                          {isPending ? 'working…' : item.state}
                        </span>
                      </button>
                    );
                  })
              )}
            </div>

            {/* Summary */}
            {!itemsLoading && items.length > 0 && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', gap: '16px' }}>
                {(['linked', 'unlinked', 'broken', 'conflict'] as const)
                  .filter((s) => (stateCounts[s] ?? 0) > 0)
                  .map((s) => (
                    <span key={s} style={{ color: stateColor(s) }}>
                      {stateCounts[s]} {s}
                    </span>
                  ))}
              </div>
            )}

            {/* Consistency hook errors */}
            {consistencyErrors && consistencyErrors.length > 0 && (
              <div style={{ fontSize: '12px', color: 'var(--accent-yellow)' }}>
                Hook errors on load:{' '}
                {consistencyErrors.map((e, i) => (
                  <span key={i}>
                    {i > 0 && ', '}
                    <strong>{e.item}</strong>: {e.error}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* CSS for hover-reveal ellipsis button */}
      <style>{`
        .pairing-item-wrapper .pairing-ellipsis-btn {
          opacity: 0;
          transition: opacity 0.15s ease;
        }
        .pairing-item-wrapper:hover .pairing-ellipsis-btn {
          opacity: 1;
        }
      `}</style>
    </div>
  );
}

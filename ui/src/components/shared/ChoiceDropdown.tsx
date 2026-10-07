import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { DisclosureChevronIcon } from './DisclosureChevronIcon';
import './ChoiceDropdown.css';

type Choice = { value: string; label: string };

/** A single-choice popover sharing the app's top-layer positioning and dismissal. */
export function ChoiceDropdown({ label, prompt, value, choices, disabled = false, hint, onChange }: {
  label: string; prompt: string; value: string; choices: Choice[]; disabled?: boolean; hint?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialIndex = useRef(0);
  const search = useRef({ text: '', at: 0 });
  const menuId = useId();
  const currentLabel = choices.find(choice => choice.value === value)?.label;
  const selectedIndex = Math.max(0, choices.findIndex(choice => choice.value === value));
  const close = () => setOpen(false);
  const menuStyle = useAnchoredMenu({ open, anchorRef: triggerRef, menuRef, onDismiss: close, placement: 'top-start', gap: 6 });
  const focusOption = (index: number) => {
    const options = menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    if (!options?.length) return;
    options[(index + options.length) % options.length]?.focus({ preventScroll: true });
  };
  const show = (index = selectedIndex) => {
    initialIndex.current = index;
    search.current = { text: '', at: 0 };
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (open) focusOption(initialIndex.current);
  }, [open]);
  useLayoutEffect(() => { if (disabled) close(); }, [disabled]);
  const select = (choice: Choice) => {
    onChange(choice.value);
    close();
    triggerRef.current?.focus({ preventScroll: true });
  };
  return <span className="choice-dropdown" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    <button type="button" ref={triggerRef} className="choice-dropdown__trigger" disabled={disabled}
      aria-label={label} title={hint ? `${label} · ${hint}` : label} aria-description={hint} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId}
      onClick={() => open ? close() : show()}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        show(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : selectedIndex);
      }}>
      <span className="choice-dropdown__label" data-current={currentLabel ?? prompt} data-prompt={prompt}>
        <span className={open || !currentLabel ? 'choice-dropdown__prompt' : undefined}>{open ? prompt : currentLabel ?? prompt}</span>
      </span>
      <DisclosureChevronIcon expanded />
    </button>
    {open && <div ref={menuRef} id={menuId} role="listbox" aria-label={label} popover="manual"
      className="choice-dropdown__menu app-anchored-menu" style={menuStyle}
      onKeyDown={event => {
        const options = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
        const index = options.indexOf(document.activeElement as HTMLElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          focusOption(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (choices[index]) select(choices[index]);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const now = Date.now();
          const text = (now - search.current.at < 700 ? search.current.text : '') + event.key.toLocaleLowerCase();
          search.current = { text, at: now };
          const match = choices.findIndex(choice => choice.label.toLocaleLowerCase().startsWith(text));
          if (match >= 0) focusOption(match);
        }
      }}>
      {choices.map(choice => <button key={choice.value} type="button" role="option" aria-selected={choice.value === value}
        tabIndex={-1} onClick={() => select(choice)}>{choice.label}</button>)}
    </div>}
  </span>;
}

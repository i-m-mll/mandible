// Bug: 11f4f47 — Violation callout block rendered inline in the chat stream
import type { JSX } from 'preact/jsx-runtime';

type PresetViolationBlockProps = {
  /** True while the sub-agent is still analyzing the violation. */
  analyzing: boolean;
  /** If a diff proposal is ready, the preset ID to navigate to. */
  presetId?: string;
  /** If a sub-agent session is running, its session ID for navigation. */
  subagentSessionId?: string;
};

export function PresetViolationBlock({
  analyzing,
  presetId,
  subagentSessionId,
}: PresetViolationBlockProps): JSX.Element {
  const handleClick = () => {
    if (analyzing && subagentSessionId) {
      window.location.hash = `#/console?session=${encodeURIComponent(subagentSessionId)}`;
    } else if (presetId) {
      window.location.hash = '#/artifacts?role=instructions';
    }
  };

  const isClickable = Boolean(
    (analyzing && subagentSessionId) || (!analyzing && presetId),
  );

  return (
    <div
      className={`preset-violation-block${isClickable ? ' preset-violation-block--clickable' : ''}`}
      onClick={isClickable ? handleClick : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      {analyzing ? (
        <span className="preset-violation-block__text">
          Workflow issue detected — analyzing...
        </span>
      ) : (
        <span className="preset-violation-block__text">
          Workflow issue — view proposed fix
        </span>
      )}
    </div>
  );
}

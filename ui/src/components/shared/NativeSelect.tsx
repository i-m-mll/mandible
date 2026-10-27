import type { JSX } from 'preact';
import { forwardRef } from 'preact/compat';
import { Icon } from '../icons/Icon';
import './NativeSelect.css';

export type NativeSelectProps = JSX.SelectHTMLAttributes<HTMLSelectElement>;

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect(
  { className, class: classAttribute, children, ...props },
  ref,
): JSX.Element {
  const classes = [className, classAttribute].filter(Boolean).join(' ');
  const showIndicator = !props.multiple && (!props.size || Number(props.size) <= 1);
  return (
    <span className={['native-select', classes].filter(Boolean).join(' ')} data-disabled={props.disabled || undefined}>
      <select {...props} ref={ref} className={classes}>{children}</select>
      {showIndicator ? <Icon name="selectIndicator" className="native-select__indicator" /> : null}
    </span>
  );
});

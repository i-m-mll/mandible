import { Icon } from './Icon';
import './native-disclosure.css';

/** Mirrors the owning native details element without keeping a second open state. */
export function NativeDisclosureIcon(): JSX.Element {
  return <span className="native-disclosure-icon"><Icon name="disclosureTextCollapsed" className="native-disclosure-icon__collapsed" /><Icon name="disclosureTextExpanded" className="native-disclosure-icon__expanded" /></span>;
}

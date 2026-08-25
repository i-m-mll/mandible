// The UI writes `JSX.Element`, `JSX.CSSProperties`, and `JSX.Targeted*Event`
// unqualified. Preact scopes its JSX namespace to its own module, so bind it
// once here instead of importing it in ninety files.
import { JSX as PreactJSX } from 'preact';

declare global {
  export import JSX = PreactJSX;
}

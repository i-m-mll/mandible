// `spaces-doc.v1` directive-ref EXTENSION to the C6 shared resource-ref parser
// (Spaces child C12, issue 9a81dab; extends C6 `feature/spaces-ref-parser`,
// issue 252e125).
//
// C6's `ui/src/resource-refs.ts` deliberately owns only the resource-ref grammar
// (bare/scheme refs and bracketed `[artifact:…]` text), exposing a
// `registerResourceRefRecognizer` extension point so the `spaces-doc.v1`
// directive grammar can teach it to ALSO recognize ref/embed DIRECTIVE nodes
// (`:ref[label]{href="…"}`, `:::embed{href="…"}`) — not just markdown links and
// bare text.
//
// The directive grammar itself is the frozen backend module
// `src/spaces/serialize.ts`; this file is the thin UI-side adapter that maps a
// parsed `spaces-doc.v1` directive node onto C6's `ParsedResourceRef` shape and
// registers it. It introduces no new grammar of its own and no executable path:
// it consumes the same pure, data-only directive parser the serializer uses.

import {
  parseSpacesDocDirectiveRef,
  type SpacesDocDirectiveRef,
} from '../../src/spaces/serialize';
import {
  registerResourceRefRecognizer,
  compactArtifactRef,
  type ParsedResourceRef,
  type ResourceRefKind,
} from './resource-refs';

function directiveDisplay(parsed: SpacesDocDirectiveRef): string {
  if (parsed.label) return parsed.label;
  if (parsed.kind === 'artifact') return compactArtifactRef(parsed.canonical);
  return parsed.canonical;
}

function directiveKind(parsed: SpacesDocDirectiveRef): ResourceRefKind {
  // The directive kinds are a superset-compatible projection of C6's kinds.
  switch (parsed.kind) {
    case 'artifact':
    case 'repo':
    case 'mandible':
    case 'issue':
    case 'comment':
      return parsed.kind;
    default:
      return 'unknown';
  }
}

/**
 * Adapt a `spaces-doc.v1` ref/embed directive node to C6's `ParsedResourceRef`.
 * Returns null when the candidate is not a directive in the profile, letting
 * C6's built-in recognizers handle bare/scheme/bracket refs as before.
 */
export function recognizeSpacesDocDirectiveRef(candidate: string): ParsedResourceRef | null {
  const parsed = parseSpacesDocDirectiveRef(candidate);
  if (!parsed) return null;
  return {
    raw: parsed.raw,
    canonical: parsed.canonical,
    kind: directiveKind(parsed),
    display: directiveDisplay(parsed),
  };
}

let unregister: (() => void) | null = null;

/**
 * Install the `spaces-doc.v1` directive recognizer into the C6 shared parser.
 * Idempotent: repeated calls keep a single registration. Returns the unregister
 * function (also used by tests).
 */
export function installSpacesDocRefRecognizer(): () => void {
  if (unregister) return unregister;
  const off = registerResourceRefRecognizer(recognizeSpacesDocDirectiveRef);
  unregister = () => {
    off();
    unregister = null;
  };
  return unregister;
}

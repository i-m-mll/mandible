import type { ToolExecutionEvidence } from '../parsers/types.js';
import type { ActivityTarget } from './activity-targets.js';
import type { ToolTransportResult } from './tool-transport.js';

export type OperationPayload = {state:'none'} | {state:'unloaded'}
  | {state:'loaded';details:{input?:Record<string,unknown>|string;result?:ToolTransportResult}};

/** Native invocation facts remain authoritative while optional source bodies are hydrated. */
export type OperationObservation = {
  operation:string;
  nativeName?:string;
  subject?:string;
  targets:ActivityTarget[];
  execution:ToolExecutionEvidence;
  payload:OperationPayload;
  timing?:{elapsedSeconds:number;scope:'operation'|'wrapper'};
  reportKind?:'final'|'update';
  children?:OperationObservation[];
};
export type CompactOperationObservation = Omit<OperationObservation,'payload'|'children'> & {
  payload:{state:'none'|'unloaded'};
  children?:CompactOperationObservation[];
};

export function compactOperationObservation(observation:OperationObservation):CompactOperationObservation {
  const {children,...facts}=observation;
  return {...facts,payload:{state:observation.payload.state==='none'?'none':'unloaded'},
    ...(children?{children:children.map(compactOperationObservation)}:{})};
}

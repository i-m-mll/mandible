import type { SessionExecutionObservation } from "./contracts.js";

export function formatSessionExecution(observation: SessionExecutionObservation | null | undefined): string {
  if (!observation) return "No execution observation";
  switch (observation.state.kind) {
    case "unknown": return "Unknown";
    case "working": return "Work start observed";
    case "stopped": return "Stopped normally";
    case "interrupted": return "Interrupted";
    case "ended": return observation.state.reason ? `Ended · ${observation.state.reason}` : "Ended";
    case "failure": return observation.state.error.type === null ? "Failure" : `Failure · ${observation.state.error.type}`;
  }
}

export function formatExecutionEvidence(observation: SessionExecutionObservation | null | undefined): string {
  if (!observation) return "";
  return `; last execution ${observation.provider}: ${formatSessionExecution(observation)} (${observation.source}, ${new Date(observation.observed_at).toISOString()})`;
}

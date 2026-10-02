import { PRODUCTION_ORIGIN } from "../canonical-origin.js";

/** Explicit HTTP clients retain their credentialed adapter. Routine local
 * managed launches use the private socket, including inherited public origin. */
export function needsManagedHttpCredential(env: NodeJS.ProcessEnv): boolean {
  const base = env.MANDIBLE_BASE?.trim().replace(/\/+$/, "");
  if (!base) return false;
  if (base === PRODUCTION_ORIGIN && env.MANDIBLE_TRANSPORT !== "http") return false;
  return /^https?:\/\//.test(base);
}

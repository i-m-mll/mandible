import { fileURLToPath } from "node:url";
import * as z from "zod";

import { runSupervisedCommand } from "../scripts/process-group-supervisor.mjs";
import { recordedPreview } from "../scripts/preview-custody.mjs";
import { branchExists, type MergeLanding } from "./merged-branch-removal.js";
import { proveMergedInto, TrashServiceError } from "./trash-service.js";

/** The outcome recorded on a `preview_teardown` action row. */
export type DeclaredTeardownOutcome = { state: "applied" | "failed"; detail: string };

/** The `outcome_detail` of a teardown refused because the merge did not land the branch. */
export const TEARDOWN_NOT_MERGED = "not_merged";

const TEARDOWN_SCRIPT = fileURLToPath(new URL("../scripts/preview-teardown.mjs", import.meta.url));
const TEARDOWN_TIMEOUT_MS = 60_000;

const TEARDOWN_RESULT = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }),
  z.object({ status: z.literal("cleaned"), runId: z.string() }),
  z.object({ status: z.literal("cleanup-pending"), reason: z.string().optional() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || text;
}

/**
 * Tear down the preview recorded for `branch` once its merge is live. A branch
 * the merge did not land keeps its preview. The teardown runs in a supervised
 * subprocess because finalization hashes and inspects synchronously. Throws
 * only when the teardown could not be run or its result read; an abort through
 * `signal` throws and records nothing.
 */
export async function tearDownDeclaredPreview(
  landing: MergeLanding,
  branch: string,
  summary: string,
  signal: AbortSignal,
): Promise<DeclaredTeardownOutcome> {
  if (!recordedPreview(branch)) return { state: "applied", detail: `No preview on ${branch}` };
  if (await branchExists(landing.checkoutRoot, branch)) {
    try {
      await proveMergedInto(landing.checkoutRoot, `refs/heads/${branch}`, landing.target);
    } catch (error) {
      if (error instanceof TrashServiceError && error.code === "branch_not_merged") return { state: "failed", detail: TEARDOWN_NOT_MERGED };
      throw error;
    }
  }
  const { stdout } = await runSupervisedCommand(
    process.execPath,
    ["--no-install", TEARDOWN_SCRIPT, "--branch", branch, "--summary", summary],
    { capture: true, timeout: TEARDOWN_TIMEOUT_MS, graceMs: 1_000, signal },
  );
  const result = TEARDOWN_RESULT.parse(JSON.parse(stdout));
  switch (result.status) {
    case "absent": return { state: "applied", detail: `No preview on ${branch}` };
    case "cleaned": return { state: "applied", detail: `Torn down run ${result.runId}` };
    case "cleanup-pending": return { state: "failed", detail: firstLine(result.reason ?? "cleanup-pending") };
    case "failed": return { state: "failed", detail: firstLine(result.error) };
  }
}

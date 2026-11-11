import { createHash } from "node:crypto";
import * as z from "zod";
import { canonicalJson } from "../canonical-json.js";
import type { AuthRequestStatus } from "../contracts.js";

/**
 * Settlement notices: what Mandible tells the session that answers for a
 * request once the request's status ends or suspends it, and whenever a
 * consequent action changes state afterwards. This file is the contract between
 * the outcome report, the notification log, the turn-start hook, the merge
 * finalizer and the Notifications view.
 *
 * Responsibility is a working convention that says who is told. It is claimed
 * identity, never authentication or authority.
 */

/** Statuses that end or suspend a request; a notice is owed from the first of them. */
export const NOTICE_STATUSES = [
  "completed", "failed", "rejected", "withdrawn", "superseded", "expired", "dismissed", "needs_rebase",
] as const satisfies readonly AuthRequestStatus[];

/**
 * `pending` completes without the owner. `withheld` waits on another step.
 * `kept` was deliberately not done and is left to the owner. `skipped` did not
 * apply. Only `done` and `skipped` count as finished follow-ups.
 */
export const OUTCOME_STEP_STATES = ["done", "pending", "failed", "withheld", "kept", "skipped"] as const;
export type OutcomeStepState = (typeof OUTCOME_STEP_STATES)[number];

/** Why a landed branch still exists. */
export const BRANCH_KEPT_REASONS = [
  "not_merged", "preview_running", "uncommitted_changes", "protected", "app_managed", "trash_refused",
] as const;
export type BranchKeptReason = (typeof BRANCH_KEPT_REASONS)[number];

interface StepBase {
  state: OutcomeStepState;
  /** Short machine reason for any state other than `done`; rendered as the group label. */
  reason: string | null;
}

export type OutcomeStep =
  /** A staged action of the request (`auth_request_actions`); `issue` is the short issue ref. */
  | (StepBase & { kind: "action"; action: string; issue: string })
  /** A merge finalizer step other than branch removal. */
  | (StepBase & { kind: "finalizer"; step: string })
  | (StepBase & { kind: "hook"; hook_id: string; required: boolean })
  | (StepBase & { kind: "branch_removal"; branch: string; reason: BranchKeptReason | null })
  | (StepBase & { kind: "preview_teardown"; branch: string });

export interface OutcomeReport {
  request_id: string;
  type: string;
  status: (typeof NOTICE_STATUSES)[number];
  /** The merge commit of a completed merge. */
  merge_commit: string | null;
  /** The rejection reason, the first error line, or the superseding request, by status. */
  reason: string | null;
  steps: OutcomeStep[];
}

/** Reads one request's current report; null when its status is not in `NOTICE_STATUSES`. */
export type OutcomeReporter = (requestId: string) => OutcomeReport | null;

/** The report's identity for "already told". */
export function outcomeReportDigest(report: OutcomeReport): string {
  return createHash("sha256").update(canonicalJson(report)).digest("hex");
}

/**
 * The merge finalizer's branch-removal step is stored in
 * `auth_requests.merge_finalizer_state` under this name, with this output. The
 * report reads branch outcomes from here and from nowhere else.
 */
export const REMOVE_MERGED_BRANCHES_STEP = "remove_merged_branches";
export const BRANCH_REMOVAL_OUTPUT = z.object({
  branches: z.array(z.object({
    branch: z.string().min(1),
    result: z.enum(["removed", "trashed", "kept", "pending"]),
    reason: z.enum(BRANCH_KEPT_REASONS).nullable(),
    worktree_path: z.string().nullable(),
  })),
});
export type BranchRemovalOutput = z.infer<typeof BRANCH_REMOVAL_OUTPUT>;

export const NOTICE_PROVIDERS = ["claude", "codex", "gemini"] as const;
export type NoticeProvider = (typeof NOTICE_PROVIDERS)[number];

/**
 * A session notice goes to the root provider session that contains the agent
 * currently answering for the subject, and is delivered at that session's main
 * thread. `session_id` is the value the provider passes as `session_id` on hook
 * stdin.
 */
export interface NoticeRecipient {
  provider: NoticeProvider;
  session_id: string;
}

export const NOTIFICATION_SUBJECT_KINDS = ["auth_request", "reminder", "credential_leak", "convergence_failure"] as const;
export type NotificationSubjectKind = (typeof NOTIFICATION_SUBJECT_KINDS)[number];

/** One row of the notification log. */
export interface NotificationRecord {
  id: string;
  subject: { kind: NotificationSubjectKind; id: string };
  recipient:
    | { kind: "session"; provider: NoticeProvider; session_id: string; responsible_agent_ref: string }
    | { kind: "user"; user_id: string };
  raised_at: number;
  /** For a session: when the hook confirmed the text reached the provider. For the user: when it was read. */
  delivered_at: number | null;
  text: string | null;
}

/**
 * `POST /api/notices/collect`: the turn-start hook's one request. It returns the
 * notices owed to the session, rendered now. An empty list is the common case
 * and must cost one indexed read.
 */
export const NOTICE_COLLECT_REQUEST = z.object({
  provider: z.enum(NOTICE_PROVIDERS),
  session_id: z.string().min(1),
});
export const NOTICE_COLLECT_RESPONSE = z.object({
  notices: z.array(z.object({ id: z.string(), text: z.string() })),
});

/** `POST /api/notices/delivered`: sent by the hook after it has written the text to stdout. */
export const NOTICE_DELIVERED_REQUEST = z.object({ ids: z.array(z.string()).min(1) });

/** `GET /api/notifications`: the log, newest first, for the Notifications view. */
export const NOTIFICATION_LIST_QUERY = z.object({
  recipient_kind: z.enum(["session", "user"]).optional(),
  undelivered: z.enum(["true", "false"]).optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** `read` is `POST`: the user's read mark on a user notification. */
export const NOTICE_ROUTES = {
  collect: "/api/notices/collect",
  delivered: "/api/notices/delivered",
  list: "/api/notifications",
  read: "/api/notifications/:id/read",
} as const;

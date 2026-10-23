// Bug: 1d652d5 — MCP tool handler implementations
//
// Each tool is a thin wrapper around a Mandible HTTP API call via client.ts.
// The MCP server registers these as tools that Claude Code can invoke.

import { execSync } from "node:child_process";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as client from "./client.js";
import type {
  InboxResponse,
  InboxWorkUnit,
  IssueRepoSummary,
} from "./types.js";

/**
 * Register all Mandible tools on the given MCP server.
 *
 * The sessionId parameter is the Mandible session ID for this channel
 * connection, discovered at startup from the environment or passed by
 * the spawning process.
 *
 * Bug: 0b454df — on first tool invocation, register the session with
 * Mandible (if not already registered at startup). Subsequent invocations
 * record tool usage for liveness tracking.
 */
export function registerTools(
  server: McpServer,
  sessionId: string | null,
): void {
  // Bug: 0b454df — track whether we've registered with Mandible
  let channelRegistered = false;

  /** Ensure channel session is registered and record a tool call. */
  async function ensureChannelRegistered(toolName: string): Promise<void> {
    if (!sessionId) return;
    if (!channelRegistered) {
      try {
        const cwd = process.env.CLAUDE_CWD ?? process.cwd();
        // Bug: 73e0adf — detect branch so channel registration includes it
        let branch: string | null = null;
        try {
          branch = execSync("git rev-parse --abbrev-ref HEAD", {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim() || null;
        } catch {
          // Not in a git repo — branch stays null
        }
        const registration = await client.registerSession({
          id: sessionId,
          status: "active",
          cwd,
          branch,
        });
        // Issue 499c148 — surface a client-token / session-binding mismatch as
        // soon as the session touches the daemon.
        const warning = registration?.identity_warning as { message?: string } | null | undefined;
        if (warning?.message) {
          process.stderr.write(`Mandible identity warning: ${warning.message}\n`);
        }
        channelRegistered = true;
      } catch {
        // Best effort — Mandible may not be running
      }
    }
    // Record tool call for liveness tracking
    try {
      await client.recordChannelToolCall(sessionId, toolName);
    } catch {
      // Best effort
    }
  }

  // 1. mandible_check_inbox
  server.tool(
    "mandible_check_inbox",
    "Check your Mandible inbox for pending items: work units needing attention, auth results, continuations from previous sessions.",
    {
      branch: z.string().optional().describe("Filter inbox by branch name"),
      repo: z.string().optional().describe("Filter inbox by repo name or ID"),
      global: z
        .boolean()
        .optional()
        .describe("If true, check all branches/repos (global inbox)"),
    },
    async (args) => {
      await ensureChannelRegistered("mandible_check_inbox");
      try {
        let inbox: InboxResponse;
        if (args.global) {
          inbox = await client.checkInboxGlobal();
        } else {
          inbox = await client.checkInbox(args.branch, args.repo);
        }
        return {
          content: [
            { type: "text", text: formatInbox(inbox) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 2. mandible_report_status
  server.tool(
    "mandible_report_status",
    "Report your current work status to Mandible for visibility in the dashboard.",
    {
      status: z
        .string()
        .describe(
          "Current status text (e.g. 'implementing feature X', 'debugging test failure')",
        ),
      issue_id: z
        .string()
        .optional()
        .describe("Issue ID this status relates to"),
      work_unit_id: z
        .string()
        .optional()
        .describe("Work unit ID to update"),
      details: z
        .string()
        .optional()
        .describe("Additional details about the work"),
    },
    async (args) => {
      await ensureChannelRegistered("mandible_report_status");
      try {
        // Update session task field if we have a session ID
        if (sessionId) {
          await client.updateSession(sessionId, {
            task: args.status,
          });
        }

        // Update work unit continuation if we have a work unit ID
        if (args.work_unit_id) {
          await client.patchWorkUnit(args.work_unit_id, {
            continuation: args.details ?? args.status,
            continuation_by: sessionId ?? "mcp-channel",
            continuation_at: Date.now(),
          });
        }

        return {
          content: [
            {
              type: "text",
              text: `Status reported${sessionId ? ` (session: ${sessionId.slice(0, 8)}...)` : ""}.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 3. mandible_submit_auth
  server.tool(
    "mandible_submit_auth",
    "Submit an auth request for a protected-branch merge. The user will authenticate via their YubiKey.",
    {
      branch: z
        .string()
        .describe("The feature/integration branch to merge"),
      title: z
        .string()
        .describe("Auth request title (e.g. 'Merge feature/xyz: description')"),
      issue_ids: z
        .array(z.string())
        .optional()
        .describe("Issue IDs to reference for context; these do not close on merge"),
      closes_issue_ids: z
        .array(z.string())
        .optional()
        .describe("Issue IDs to close on successful merge"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory (repo root or worktree)"),
      message: z
        .string().refine(value => value.trim().length > 0, "Description must not be blank")
        .describe(
          "Required canonical change message, used verbatim as the merge commit message: an outcome subject line, " +
            "a blank line, a short Why paragraph, then a line reading 'Verification:' followed by exactly the " +
            "`verification` text. No line may start with '#'.",
        ),
      verification: z
        .string()
        .describe("Required single-paragraph verification text: the checks you ran and their results"),
    },
    async (args) => {
      await ensureChannelRegistered("mandible_submit_auth");
      try {
        // Issue 08a5f04 — approve-time canonical enforcement only accepts
        // `mandible auth merge <head> --into <base>`, so emit the canonical
        // form whenever the protected base can be resolved here. The daemon
        // re-validates the base (protected, existing, ancestry) regardless.
        const cwd = args.cwd ?? process.env.CLAUDE_CWD ?? process.cwd();
        const base = detectProtectedBranch(cwd);
        const canonical =
          base !== null && SAFE_BRANCH_RE.test(args.branch) && SAFE_BRANCH_RE.test(base);
        // When the base cannot be resolved pre-submission, fall back to the
        // legacy single-source shape: the daemon normalizes exactly that shape
        // to the canonical form at POST submission after resolving the base.
        const command = canonical
          ? `mandible auth merge ${args.branch} --into ${base}`
          : `mandible auth merge ${args.branch}`;

        const result = await client.submitAuth({
          command,
          title: args.title,
          head_branch: args.branch,
          ...(canonical ? { base_branch: base } : {}),
          issue_references: args.issue_ids ?? null,
          issue_closures: args.closes_issue_ids ?? null,
          issues: args.closes_issue_ids ?? null,
          cwd,
          // Issue 4720024 — the daemon refuses merge requests without a
          // canonical change message and its verification text.
          canonical_message: true,
          commit_message: args.message,
          verification: args.verification,
          session_id: sessionId,
        });

        return {
          content: [
            {
              type: "text",
              text: `Auth request submitted (ID: ${result.request_id}). The user will authenticate via their YubiKey in the Mandible dashboard. You will be notified when it resolves.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 4. mandible_get_issues
  server.tool(
    "mandible_get_issues",
    "List open issues from the Mandible ledger across tracked repositories.",
    {
      repo: z
        .string()
        .optional()
        .describe("Filter by repo name or ID"),
      status: z
        .enum(["open", "closed", "merged"])
        .optional()
        .describe("Filter by issue status (default: all)"),
      label: z
        .string()
        .optional()
        .describe("Filter by label (e.g. 'feature', 'error', 'umbrella')"),
    },
    async (args) => {
      await ensureChannelRegistered("mandible_get_issues");
      try {
        const summaries = await client.getIssues({
          repo: args.repo,
          status: args.status,
          label: args.label,
        });
        return {
          content: [
            { type: "text", text: formatIssues(summaries) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // 5. mandible_request_work
  server.tool(
    "mandible_request_work",
    "Find available work units (unassigned issues needing attention) and optionally self-assign.",
    {
      repo_id: z
        .string()
        .optional()
        .describe("Filter by repo ID"),
      state: z
        .string()
        .optional()
        .describe("Work unit state filter (default: 'open')"),
      assign: z
        .boolean()
        .optional()
        .describe(
          "If true, self-assign the first available work unit to this session",
        ),
    },
    async (args) => {
      await ensureChannelRegistered("mandible_request_work");
      try {
        const result = await client.getWorkUnits({
          state: args.state ?? "open",
          repo_id: args.repo_id,
        });

        // Filter to unassigned work units: their agent has stopped. One whose
        // liveness is unknown may still be worked on.
        const available = result.work_units.filter(
          (wu) => wu.liveness.state === "stopped",
        );

        if (available.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No unassigned work units found. All work is either assigned or completed.",
              },
            ],
          };
        }

        // Optionally self-assign the first available
        if (args.assign && sessionId && available.length > 0) {
          const wu = available[0];
          await client.patchWorkUnit(wu.id, {
            assigned_session_id: sessionId,
          });
          return {
            content: [
              {
                type: "text",
                text: `Assigned work unit ${wu.id.slice(0, 8)}... (issue: ${wu.issue_id.slice(0, 8)}..., repo: ${wu.repo_id}, branch: ${wu.branch ?? "none"}).\n\n${formatWorkUnits(available)}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: formatWorkUnits(available),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

}

// --- Merge command helpers (issue 08a5f04) ---

// Branch names safe to embed in the canonical command string. Mirrors the
// daemon's safe-branch byte set; anything else falls back to the legacy shape
// and server-side validation.
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Resolve the protected base branch the same way cli/auth-request.sh's
 * detect_protected_branch does: `develop` when it exists locally, else `main`.
 * Returns null when the cwd is not a usable git repo, letting the caller fall
 * back to the legacy command shape (normalized server-side at submission).
 */
function detectProtectedBranch(cwd: string): string | null {
  const hasLocalBranch = (branch: string): boolean => {
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${branch}`, {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  };
  try {
    if (hasLocalBranch("develop")) return "develop";
    if (hasLocalBranch("main")) return "main";
    return null;
  } catch {
    return null;
  }
}

// --- Formatting helpers ---

function formatInbox(inbox: InboxResponse): string {
  const sections: string[] = [];

  if (inbox.total === 0) {
    return "Inbox is empty — no pending items.";
  }

  sections.push(`Total pending items: ${inbox.total}`);

  if (inbox.auth_results.length > 0) {
    sections.push("\n## Auth Results");
    for (const ar of inbox.auth_results) {
      const status = ar.exit_code === 0 ? "SUCCESS" : ar.status.toUpperCase();
      sections.push(
        `- [${status}] "${ar.title}" (branch: ${ar.head_branch ?? "?"})${ar.error ? ` — error: ${ar.error}` : ""}`,
      );
    }
  }

  if (inbox.work_units.length > 0) {
    sections.push("\n## Work Units Needing Attention");
    for (const wu of inbox.work_units) {
      sections.push(
        `- ${wu.issue_id.slice(0, 8)}... [${wu.state}] repo: ${wu.repo_id}, branch: ${wu.branch ?? "unassigned"}`,
      );
    }
  }

  if (inbox.work_unit_continuations.length > 0) {
    sections.push("\n## Work Unit Continuations");
    for (const wu of inbox.work_unit_continuations) {
      sections.push(
        `- ${wu.issue_id.slice(0, 8)}... continuation: ${wu.continuation?.slice(0, 100) ?? ""}`,
      );
    }
  }

  if (inbox.continuations.length > 0) {
    sections.push("\n## Session Continuations");
    for (const c of inbox.continuations) {
      sections.push(
        `- Session ${c.session_id.slice(0, 8)}... (branch: ${c.branch}): ${c.continuation.slice(0, 100)}`,
      );
    }
  }

  if (inbox.open_issues.length > 0) {
    sections.push("\n## Open Issues");
    for (const issue of inbox.open_issues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
      sections.push(`- ${issue.id.slice(0, 8)}... "${issue.title}"${labels}`);
    }
  }

  if (inbox.pending_webhooks && inbox.pending_webhooks.length > 0) {
    sections.push("\n## Pending Webhooks");
    for (const wh of inbox.pending_webhooks) {
      const title = wh.title ? ` "${wh.title}"` : "";
      const target = wh.target_branch ? ` branch: ${wh.target_branch}` : wh.target_issue ? ` issue: ${wh.target_issue}` : "";
      sections.push(`- ${wh.id.slice(0, 8)}... [${wh.source}/${wh.event_type}]${title} (${wh.priority})${target}`);
    }
  }

  return sections.join("\n");
}

function formatIssues(summaries: IssueRepoSummary[]): string {
  if (summaries.length === 0) {
    return "No issues found matching the given filters.";
  }

  const sections: string[] = [];

  for (const repo of summaries) {
    if (repo.issues.length === 0) continue;

    sections.push(
      `## ${repo.repo_name} (open: ${repo.open_count}, merged: ${repo.merged_count}, closed: ${repo.closed_count})`,
    );

    for (const issue of repo.issues) {
      const labels =
        issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
      sections.push(
        `- ${issue.id.slice(0, 8)}... [${issue.status}] "${issue.title}"${labels}`,
      );
    }
  }

  return sections.join("\n") || "No issues found.";
}

function formatWorkUnits(workUnits: InboxWorkUnit[]): string {
  if (workUnits.length === 0) {
    return "No work units available.";
  }

  const lines: string[] = [`Available work units: ${workUnits.length}`];
  for (const wu of workUnits) {
    lines.push(
      `- ${wu.id.slice(0, 8)}... issue: ${wu.issue_id.slice(0, 8)}..., repo: ${wu.repo_id}, state: ${wu.state}, branch: ${wu.branch ?? "none"}, kind: ${wu.kind}`,
    );
    if (wu.continuation) {
      lines.push(`  Continuation: ${wu.continuation.slice(0, 100)}`);
    }
  }

  return lines.join("\n");
}

function errorResult(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const msg =
    err instanceof Error ? err.message : "Unknown error occurred";
  return {
    content: [{ type: "text", text: `Error: ${msg}` }],
    isError: true,
  };
}

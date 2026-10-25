#!/usr/bin/env bun
// Measures the largest event-loop turn each daemon route causes, on a copy of
// production data. The route list comes from the daemon's own router
// (/api/instance), so a new route is either exercised, skipped with a stated
// reason, or fails the sweep as unclassified. Docs: docs/daemon-stall-profiling.md.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONFIRMATION_TRIALS, judgeRoute, trialTurns, waitForLoad, writeReplayPlan } from "./route-cost-judgment.ts";
import { evictFileCache } from "./evict-file-cache.ts";
import SqliteDatabase from "../src/sqlite.ts";
import { isProtectedIdentitySettingKey } from "../src/settings-key-policy.js";
import { numericSourceExtent } from "../src/conversations/source-observer.ts";
import { localApiSocketPath } from "../src/local-api-socket.ts";
import { resolveLedgerDbPath } from "../src/db-read.ts";
import { EVENT_LOOP_STALL_BUDGET_MS, HANDLER_TURN_BUDGET_MS } from "../src/runtime-health-contract.ts";
import { DEFAULT_TIMELINE_VIEW_STATE } from "../ui/src/types/timeline.ts";
import {
  bunRuntime,
  previewInstanceEnv,
  sanitizedLauncherEnv,
  sanitizePreviewDatabase,
  seedPreviewUserPreferences,
  seedProjectedConversationStructureCache,
} from "./iab-preview.mjs";

const USAGE = `Usage: bun scripts/route-cost-sweep.ts [options]

Snapshots the production ledger, starts a preview daemon of this checkout on
it, drives every route the router declares with parameters drawn from the
snapshot (all read passes first, then the database-only writes), and reports
each route's event-loop turns. Confirms suspected offenders in three fresh
trials. Fails when the same call kind reaches --threshold-ms in every trial
without a BUDGET_EXCEPTIONS entry, when a route is
unclassified, or when a request does not succeed.

  --source-db <path>    Ledger to snapshot (default: the installation ledger, MANDIBLE_DB or MANDIBLE_HOME/mandible.db)
  --work-root <path>    Parent directory for this sweep's private working files
  --threshold-ms <n>    Fail at or above this turn (default HANDLER_TURN_BUDGET_MS)
  --passes <n>          Requests per variant; the first is cold (default 2)
  --only <regex>        Exercise only routes whose path matches; others report as excluded
  --fresh-each          Start a fresh daemon for each route, so every first call is cold
  --evict               Evict snapshot DB/WAL cache before first calls (macOS; timing report only)
  --cpu-prof            Profile the daemon and attribute each offender's window
  --ignore-load         Skip the bounded wait for load below the core count
  --keep                Keep the sweep root (snapshot, logs, profile)
  --json                Print the result as JSON on stdout`;

export function parseSweepOptions(args: string[]) {
  return parseArgs({
    args,
    options: {
      "source-db": { type: "string" },
      "work-root": { type: "string" },
      "threshold-ms": { type: "string", default: String(HANDLER_TURN_BUDGET_MS) },
      passes: { type: "string", default: "2" },
      only: { type: "string" },
      "cpu-prof": { type: "boolean", default: false },
      "fresh-each": { type: "boolean", default: false },
      evict: { type: "boolean", default: false },
      "ignore-load": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }).values;
}

const opts = parseSweepOptions(import.meta.main ? process.argv.slice(2) : []);

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TURN_ROUTE = "/api/diagnostics/event-loop-turn";
const SETTLE_MS = 50;
const QUIET_MS = 20;
const QUIET_DEADLINE_MS = 600_000;
const BASELINE_MS = 5_000;
const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 180_000;

const thresholdMs = Number(opts["threshold-ms"]);
const passes = Number(opts.passes);
if (!(thresholdMs > 0) || !Number.isInteger(passes) || passes < 1) {
  console.error("route-cost-sweep: --threshold-ms must be positive and --passes a positive integer");
  process.exit(2);
}
const only = opts.only ? new RegExp(opts.only) : null;
const sourceDb = path.resolve(opts["source-db"] ?? resolveLedgerDbPath());

function log(message: string) {
  console.error(`route-cost-sweep: ${message}`);
}

// --- route catalog ---------------------------------------------------------

type Effect = string;
interface CatalogRoute {
  method: string;
  path: string;
  operationId: string;
  operationalMutationCategory: string | null;
  effects: Effect[] | null;
}
/** A function is evaluated per pass, for writes that cannot repeat on the same entity. */
type PerPass<T> = T | ((pass: number) => T);
interface SweepRequest {
  label: string;
  url: PerPass<string>;
  body?: PerPass<unknown>;
}
type Plan =
  | { kind: "exercise"; requests: SweepRequest[] }
  | { kind: "skip"; reason: string };


/**
 * How the sweep drives each route that needs more than a bare GET: the
 * requests to send, built from snapshot data, or the reason it cannot send
 * any. A non-GET route, or a GET route with path parameters, that has no entry
 * fails the sweep, so a new route cannot escape it.
 */
type RouteEntry = (fx: Fixtures) => SweepRequest[] | string;

const READS: Record<string, RouteEntry> = {
  "GET /api/auth/request/:id": (fx) => [req(`/api/auth/request/${fx.authRequest}`)],
  "GET /api/auth/request/:id/actions": (fx) => [req(`/api/auth/request/${fx.authRequest}/actions`)],
  "GET /api/auth/request/:id/candidate-acceptance": (fx) => [req(`/api/auth/request/${fx.acceptedAuthRequest}/candidate-acceptance`)],
  "GET /api/auth/history": () => [req("/api/auth/history"), req("/api/auth/history?limit=200")],
  "GET /api/auth/clearances/:id": (fx) => fx.clearance ? [req(`/api/auth/clearances/${fx.clearance}`)] : [],
  "GET /api/work/repos": () => [req("/api/work/repos"), req("/api/work/repos?include_excluded=true")],
  "GET /api/work/repos/:id/branches": (fx) => [req(`/api/work/repos/${enc(fx.workRepo)}/branches`)],
  "GET /api/work/repos/:id/worktrees": (fx) => [req(`/api/work/repos/${enc(fx.workRepo)}/worktrees`)],
  "GET /api/work/repos/:id/branch/:name": (fx) => [req(`/api/work/repos/${enc(fx.workRepo)}/branch/${enc(fx.branch)}`)],
  "GET /api/issues/search": (fx) => [req(`/api/issues/search?q=${enc(fx.searchWord)}`), req(`/api/issues/search?q=${enc(fx.searchWord)}&status=all&limit=50`)],
  "GET /api/ledger/issues/:issueId": (fx) => [req(`/api/ledger/issues/${fx.issue}?stage=initial`), req(`/api/ledger/issues/${fx.issue}`), req(`/api/ledger/issues/${fx.umbrella}`)],
  "GET /api/ledger/issues/:issueId/umbrella-status": (fx) => [req(`/api/ledger/issues/${fx.umbrella}/umbrella-status`), req(`/api/ledger/issues/${fx.umbrella}/umbrella-status?deep=1`)],
  "GET /api/ledger/issues/:issueId/parent-role": (fx) => [req(`/api/ledger/issues/${fx.umbrella}/parent-role`)],
  "GET /api/ledger/issues/:issueId/head": (fx) => [req(`/api/ledger/issues/${fx.umbrella}/head`)],
  "GET /api/ledger/issues/:issueId/body/revisions": (fx) => [req(`/api/ledger/issues/${fx.issue}/body/revisions`)],
  "GET /api/ledger/issues/:issueId/work-notes/history": (fx) => [req(`/api/ledger/issues/${fx.issue}/work-notes/history`)],
  "GET /api/ledger/comments/:commentId/revisions": (fx) => [req(`/api/ledger/comments/${fx.comment}/revisions`)],
  "GET /api/ledger/body-revisions/:revisionId": (fx) => [req(`/api/ledger/body-revisions/${fx.bodyRevision}`)],
  "GET /api/issues/:repoId/:issueId/ledger-detail": (fx) => [req(`/api/issues/${enc(fx.issueRepo)}/${fx.issueShort}/ledger-detail?stage=initial`), req(`/api/issues/${enc(fx.issueRepo)}/${fx.issueShort}/ledger-detail`)],
  "GET /api/ledger/issues/:issueId/checkpoints": (fx) => [req(`/api/ledger/issues/${fx.umbrella}/checkpoints`)],
  // The route answers 409 for an issue whose project has several checkouts.
  "GET /api/issues/find/:issueId": (fx) => [req(`/api/issues/find/${fx.soloIssue.slice(0, 7)}`)],
  "GET /api/issues/resolutions/:issueId": (fx) => [req(`/api/issues/resolutions/${fx.issueShort}`)],
  "GET /api/issues/:repoId/:issueId": (fx) => [req(`/api/issues/${enc(fx.issueRepo)}/${fx.issueShort}`)],
  "GET /api/issues/:repoId/:issueId/context": (fx) => [req(`/api/issues/${enc(fx.issueRepo)}/${fx.issueShort}/context`)],
  "GET /api/issues/:repoId/:issueId/sessions": (fx) => [req(`/api/issues/${enc(fx.issueRepo)}/${fx.issueShort}/sessions`)],
  "GET /api/ledger/changes": (fx) => [req(`/api/ledger/changes?project=${enc(fx.projectKey)}&limit=200`)],
  "GET /api/settings/:key": (fx) => fx.settingKeys.map((key) => req(`/api/settings/${enc(key)}`)),
  "GET /api/user-settings/:key": () => ["app_rail_order", "managed_chat_defaults"].map((key) => req(`/api/user-settings/${key}`)),
  "GET /api/system/logs": () => [req("/api/system/logs"), req("/api/system/logs?limit=500")],
  "GET /api/sessions": () => [req("/api/sessions"), req("/api/sessions?status=all&limit=200")],
  "GET /api/sessions/by-pid/:pid": (fx) => [req(`/api/sessions/by-pid/${fx.sessionPid}`)],
  "GET /api/sessions/:id": (fx) => [req(`/api/sessions/${fx.session}`)],
  "GET /api/sessions/:id/tree": (fx) => [req(`/api/sessions/${fx.session}/tree`)],
  "GET /api/sessions/:id/overview": (fx) => [req(`/api/sessions/${fx.session}/overview`)],
  "GET /api/sessions/:id/issues": (fx) => [req(`/api/sessions/${fx.session}/issues`)],
  "GET /api/graph": () => [
    ...["issue", "work", "activity", "provenance", "provider-lineage", "artifact-lineage"]
      .map((mode) => req(`/api/graph?mode=${mode}&limit=120`)),
    req("/api/graph?status=all"),
  ],
  "GET /api/providers/:id": (fx) => fx.provider ? [req(`/api/providers/${enc(fx.provider)}`)] : [],
  "GET /api/providers/:id/capabilities": (fx) => fx.provider ? [req(`/api/providers/${enc(fx.provider)}/capabilities`)] : [],
  "GET /api/providers/:id/health": (fx) => fx.provider ? [req(`/api/providers/${enc(fx.provider)}/health`)] : [],
  "GET /api/artifacts": () => [req("/api/artifacts"), req("/api/artifacts?limit=500")],
  "GET /api/artifacts/resolve": (fx) => [req(`/api/artifacts/resolve?ref=${enc(fx.artifactRef)}`)],
  "GET /api/artifacts/series": () => [req("/api/artifacts/series?limit=200&summary=true"), req("/api/artifacts/series")],
  "GET /api/artifacts/versions": (fx) => [req(`/api/artifacts/versions?ref=${enc(fx.artifact)}`)],
  "GET /api/artifacts/drafts": (fx) => [req(`/api/artifacts/drafts?ref=${enc(fx.artifact)}`)],
  "GET /api/artifacts/diff": (fx) => [req(`/api/artifacts/diff?a=${enc(fx.artifactVersionA)}&b=${enc(fx.artifactVersionB)}`)],
  "GET /api/artifacts/source": (fx) => [req(`/api/artifacts/source?ref=${enc(fx.artifact)}`)],
  "GET /api/artifacts/bundles/:id": (fx) => [req(`/api/artifacts/bundles/${enc(fx.artifactVersionB)}`)],
  "GET /api/artifacts/:id/content": (fx) => [req(`/api/artifacts/${enc(fx.artifactVersionB)}/content`)],
  "GET /api/artifacts/:id/check": (fx) => [req(`/api/artifacts/${enc(fx.artifact)}/check`)],
  "GET /api/artifacts/:id/knowledge-backrefs": (fx) => [req(`/api/artifacts/${enc(fx.artifact)}/knowledge-backrefs`)],
  "GET /api/artifacts/:id": (fx) => [req(`/api/artifacts/${enc(fx.artifact)}`)],
  "GET /api/work-units": () => [req("/api/work-units"), req("/api/work-units?state=all")],
  "GET /api/work-units/custody-check": (fx) => [req(`/api/work-units/custody-check?repo=${enc(fx.workUnitRepo)}&branch=${enc(fx.workUnitBranch)}`)],
  "GET /api/work-units/:id": (fx) => [req(`/api/work-units/${fx.workUnit}`)],
  "GET /api/inbox": (fx) => [req(`/api/inbox?branch=${enc(fx.workUnitBranch)}`)],
  "GET /api/console/run-options": () => [req("/api/console/run-options?backend_type=pty&command=claude")],
  "GET /api/console/sessions/:id/permissions": (fx) => fx.consoleSession ? [req(`/api/console/sessions/${fx.consoleSession}/permissions`)] : [],
  "GET /api/conversation-spawns/:id": (fx) => fx.spawn ? [req(`/api/conversation-spawns/${fx.spawn}`)] : [],
  "GET /api/hooks/session-execution": (fx) => [req(`/api/hooks/session-execution?provider=claude&session_id=${enc(fx.providerSession)}`)],
  "GET /api/inbox/undelivered": (fx) => [req(`/api/inbox/undelivered?target_session_id=${enc(fx.providerSession)}`)],
  "GET /api/hooks/statusline": (fx) => [req(`/api/hooks/statusline?session_id=${enc(fx.providerSession)}&cwd=${enc(fx.checkoutRoot)}`)],
  "GET /api/spaces": (fx) => [req("/api/spaces"), req(`/api/spaces?project_id=${enc(fx.project)}`)],
  "GET /api/spaces/resolve": (fx) => [req(`/api/spaces/resolve?ref=${enc(`issue:${fx.issueShort}`)}`)],
  "GET /api/refs/resolve": (fx) => [req(`/api/refs/resolve?ref=${enc(`issue:${fx.issueShort}`)}`)],
  "GET /api/spaces/:id": (fx) => fx.space ? [req(`/api/spaces/${fx.space}`)] : [],
  "GET /api/spaces/:id/blocks": (fx) => fx.space ? [req(`/api/spaces/${fx.space}/blocks`)] : [],
  "GET /api/spaces/:id/publications": (fx) => fx.space ? [req(`/api/spaces/${fx.space}/publications`)] : [],
  "GET /api/spaces/:id/document/download": (fx) => fx.documentSpace ? [req(`/api/spaces/${fx.documentSpace}/document/download`)] : [],
  "GET /api/briefing-destination-routes/:routeKey": (fx) => fx.routeKey ? [req(`/api/briefing-destination-routes/${enc(fx.routeKey)}`)] : [],
  "GET /api/briefing-groups/:groupId": (fx) => [req(`/api/briefing-groups/${fx.briefingGroup}`)],
  "GET /api/briefing-bundles/:bundleId": (fx) => [req(`/api/briefing-bundles/${fx.briefingBundle}`)],
  "GET /api/briefings/:briefingId": (fx) => [req(`/api/briefings/${fx.briefing}`)],
  "GET /api/briefings/:briefingId/rounds/:roundId/submissions/:submissionId/export": (fx) => fx.submission
    ? [req(`/api/briefings/${fx.submission.briefing}/rounds/${fx.submission.round}/submissions/${fx.submission.id}/export`)]
    : [],
  "GET /api/reminders/:id": (fx) => fx.reminder ? [req(`/api/reminders/${fx.reminder}`)] : [],
  "GET /api/projects/:ref/access": (fx) => [req(`/api/projects/${enc(fx.projectKey)}/access`)],
  "GET /api/projects/:ref": (fx) => [req(`/api/projects/${enc(fx.projectKey)}`)],
  "GET /api/workflows": () => [req("/api/workflows"), req("/api/workflows?limit=200")],
  "GET /api/workflows/:id": (fx) => fx.workflow ? [req(`/api/workflows/${fx.workflow}`)] : [],
  "GET /r/issue/:ref": (fx) => [req(`/r/issue/${fx.issueShort}`)],
  "GET /r/auth/:ref": (fx) => [req(`/r/auth/${fx.authRequest.slice(0, 8)}`)],
  "GET /r/artifact/:ref": (fx) => [req(`/r/artifact/${enc(fx.artifactRef)}`)],
  "GET /r/briefing/:ref": (fx) => [req(`/r/briefing/${fx.briefing}`)],
  "GET /issue/:ref": (fx) => [req(`/issue/${fx.issueShort}`)],
  "GET /auth/:ref": (fx) => [req(`/auth/${fx.authRequest.slice(0, 8)}`)],
  "GET /artifact/:ref": (fx) => [req(`/artifact/${enc(fx.artifactRef)}`)],
  "GET /briefing/:ref": (fx) => [req(`/briefing/${fx.briefing}`)],
  "GET /api/conversations/resolve-target": (fx) => [req(`/api/conversations/resolve-target?session=${enc(fx.bigConversationSession)}`)],
  "GET /api/conversations/sidebar": (fx) => [
    req("/api/conversations/sidebar?limit=5"),
    req("/api/conversations/sidebar?limit=50&exclude_subagents=true"),
    req(`/api/conversations/sidebar?limit=50&project_ids=${enc(fx.project)}`),
    req(`/api/conversations/sidebar?limit=50&search=${enc(fx.searchWord)}&full_text=true`),
  ],
  "GET /api/conversations": () => [req("/api/conversations"), req("/api/conversations?limit=200")],
  "GET /api/conversations/search": (fx) => [req(`/api/conversations/search?q=${enc(fx.searchWord)}`)],
  "GET /api/conversations/:id/structure": (fx) => fx.conversations.map((id) => req(`/api/conversations/${id}/structure`)),
  "GET /api/conversations/:id": (fx) => fx.conversations.map((id) => req(`/api/conversations/${id}`)),
  "GET /api/conversations/:id/forks": (fx) => fx.conversations.map((id) => req(`/api/conversations/${id}/forks`)),
  "GET /api/conversations/:id/blocks": (fx) => fx.conversations.map((id) => req(`/api/conversations/${id}/blocks?limit=200`)),

  "GET /api/conversations/:id/control/attachments": (fx) => [req(`/api/conversations/${fx.bigConversation}/control/attachments`)],
  "GET /api/conversations/:id/control": (fx) => [req(`/api/conversations/${fx.bigConversation}/control`)],
  "GET /api/conversations/:id/control/live": (fx) => [req(`/api/conversations/${fx.bigConversation}/control/live`)],
  "GET /api/conversations/:id/control/permissions": (fx) => [req(`/api/conversations/${fx.bigConversation}/control/permissions`)],
  "GET /api/conversations/:id/control/settings": (fx) => [req(`/api/conversations/${fx.bigConversation}/control/settings`)],
  "GET /api/conversations/:id/control/options": (fx) => [req(`/api/conversations/${fx.bigConversation}/control/options`)],

  "GET /api/auth/clearances": () => "requires the durable Keychain client credential",
  "GET /api/users/operator/signing-key": () => "requires the durable Keychain client credential",
  "GET /api/work-units/custody-check": () => "requires the durable Keychain client credential",
  "GET /api/client-auth/forward-auth": () => "front-door forward-auth check; needs a browser session cookie",
  "GET /api/chat-attachments/:id/content": () => "attachment bytes live outside the ledger snapshot",

  "POST /api/diagnostics/event-loop-turn": () => "the sweep's own measurement read",
  "POST /api/events/subscribe": () => "stream subscription; the event stream is served outside the router",
  "POST /api/auth/check": () => "reads, but runs git in the checkout (process:external)",
  "POST /api/timeline/project": (fx) => timelineRequests(fx),
  "POST /api/briefing-destination-routes/plan": (fx) => [post("current routes", "/api/briefing-destination-routes/plan", destinationRouteManifest(fx))],
};

/**
 * Routes allowed over the budget, each citing the open issue that fixes it.
 * An offender with no entry fails the sweep, and so does an entry whose issue
 * is not open in the snapshot.
 */
const BUDGET_EXCEPTIONS: Record<string, { issue: string }> = {};

const AUTH_TRANSITION = "auth queue transition; needs a pending request in a particular state, owned by the caller's session";
const LIVE_CONSOLE = "acts on a live console agent process";
const NOT_DRIVEN = "not driven yet: ";
const SWEEP_TAG = "route-cost-sweep";

/**
 * Write routes. They run against the snapshot copy, after every read pass, so
 * their effects never reach a read measurement. A route that writes anywhere
 * besides the snapshot database and the preview's own files is a named skip.
 */
const WRITES: Record<string, RouteEntry> = {
  "POST /api/ledger/issues/:issueId/umbrella-adopt": (fx) => [
    post("re-adopt existing children", `/api/ledger/issues/${fx.umbrella}/umbrella-adopt`, { child_refs: fx.umbrellaChildren }),
  ],
  "POST /api/ledger/issues/:issueId/umbrella-manifest-refresh": (fx) => [
    post("largest umbrella", `/api/ledger/issues/${fx.umbrella}/umbrella-manifest-refresh`, {}),
  ],
  "POST /api/ledger/issues/:issueId/parent-role": (fx) => [
    post("assume", `/api/ledger/issues/${fx.umbrella}/parent-role`, { session_id: fx.session, override: true }),
  ],
  "DELETE /api/ledger/issues/:issueId/parent-role": (fx) => [
    post("release", `/api/ledger/issues/${fx.umbrella}/parent-role`, { override: true }),
  ],
  "POST /api/ledger/relationships": (fx) => [
    post("link", "/api/ledger/relationships", { source_ref: fx.issue, target_refs: [fx.umbrella], link_type: "references" }),
  ],
  "POST /api/ledger/relationships/unlink": (fx) => [
    post("unlink", "/api/ledger/relationships/unlink", { source_ref: fx.issue, target_refs: [fx.umbrella], link_type: "references" }),
  ],
  "POST /api/issues/resolutions": () => `${NOT_DRIVEN}needs a commit that resolves an issue`,
  "POST /api/issues/:repoId": (fx) => [
    post("new issue", `/api/issues/${fx.issueRepo}`, { title: `${SWEEP_TAG} probe`, body: "Created by the route-cost sweep on a snapshot." }),
  ],
  "POST /api/ledger/issues/:issueId/comments": (fx) => [
    post("busiest issue", `/api/ledger/issues/${fx.issue}/comments`, { body: `${SWEEP_TAG} comment` }),
  ],
  "POST /api/ledger/issues/:issueId/checkpoints": (fx) => [
    post("closeout", `/api/ledger/issues/${fx.issue}/checkpoints`, {
      kind: "closeout",
      payload: { worker_status: "done", branch: `feature/${SWEEP_TAG}`, auth_request: "", blockers: [], next_action: "" },
    }),
  ],
  "PATCH /api/ledger/comments/:commentId": (fx) => [
    post("most-edited comment", `/api/ledger/comments/${fx.comment}`, { body: `${SWEEP_TAG} edit` }),
  ],
  "PATCH /api/ledger/issues/:issueId": (fx) => [
    post("work notes", `/api/ledger/issues/${fx.issue}`, { work_notes: `${SWEEP_TAG} notes` }),
  ],
  "POST /api/ledger/issues/:issueId/worker-status": (fx) => [
    post("blocked", `/api/ledger/issues/${fx.issue}/worker-status`, { worker_status: "blocked" }),
  ],
  "POST /api/ledger/issues/:issueId/branches": (fx) => [
    post("superseded branch", `/api/ledger/issues/${fx.issue}/branches`, { branch: `feature/${SWEEP_TAG}-superseded`, role: "superseded" }),
  ],
  "POST /api/ledger/issues/:issueId/labels": (fx) => [
    post("add label", `/api/ledger/issues/${fx.issue}/labels`, { label: SWEEP_TAG, present: true }),
  ],

  "POST /api/work-units/claim": (fx) => [
    post("claim", "/api/work-units/claim", { issue_id: fx.issue, repo_id: fx.workRepo, branch: `feature/${SWEEP_TAG}` }),
  ],
  "POST /api/work-units/activate": (fx) => [
    post("activate", "/api/work-units/activate", { issue_id: fx.issue, repo_id: fx.workRepo, branch: `feature/${SWEEP_TAG}` }),
  ],
  "POST /api/work-units/release": () => `${NOT_DRIVEN}needs the custody generation the claim returned`,
  "POST /api/work-units/release-issue": () => `${NOT_DRIVEN}takes the caller's snapshot of the issue's work-unit generations`,
  "POST /api/work-units/:id/custody/assume": () => `${NOT_DRIVEN}needs a work unit whose holder is dead, at its current custody generation`,
  "PATCH /api/work-units/:id": (fx) => [
    post("continuation", `/api/work-units/${fx.workUnit}`, { continuation: `${SWEEP_TAG} handoff` }),
  ],

  "POST /api/inbox/delivered/:id": (fx) => {
    const results = fixtureRows("undelivered auth results for all passes", fx.undeliveredAuthResults, passes);
    return [post("auth result", (pass) => `/api/inbox/delivered/${results[pass - 1]}`, {})];
  },
  "POST /api/inbox/:type/:id/ack": (fx) => {
    const results = fixtureRows("unacknowledged auth results for all passes", fx.unacknowledgedAuthResults, passes);
    return [post("auth result", (pass) => `/api/inbox/auth_result/${results[pass - 1]}/ack`, {})];
  },
  "POST /api/inbox/ack-all": () => [post("everything", "/api/inbox/ack-all", {})],

  "PATCH /api/console/sessions/:id/options": () => LIVE_CONSOLE,
  "POST /api/console/sessions/:id/permission/:requestId": () => LIVE_CONSOLE,
  "POST /api/console/sessions/:id/cancel": () => LIVE_CONSOLE,
  "PUT /api/console/pinned": (fx) => [post("pin one", "/api/console/pinned", { ids: [fx.bigConversation] })],
  "POST /api/webhooks/:id/dismiss": (fx) => {
    const events = fixtureRows("pending webhook events for all passes", fx.webhookEvents, passes);
    return [post("pending event", (pass) => `/api/webhooks/${events[pass - 1]}/dismiss`, {})];
  },

  "POST /api/spaces": (fx) => [post("new space", "/api/spaces", { title: `${SWEEP_TAG} space`, project_id: fx.project })],
  "PATCH /api/spaces/:id": (fx) => fx.space ? [post("largest space", `/api/spaces/${fx.space}`, { description: `${SWEEP_TAG}` })] : [],
  "DELETE /api/spaces/:id": () => `${NOT_DRIVEN}needs a space created earlier in the same pass`,
  "POST /api/spaces/:id/items": (fx) => fx.space ? [post("issue item", `/api/spaces/${fx.space}/items`, { ref_type: "issue", ref_id: fx.umbrella })] : [],
  "PATCH /api/spaces/:id/items/:item_id": (fx) => fx.space && fx.spaceItem
    ? [post("retitle", `/api/spaces/${fx.space}/items/${fx.spaceItem}`, { title: `${SWEEP_TAG} item` })]
    : [],
  "DELETE /api/spaces/:id/items/:item_id": () => `${NOT_DRIVEN}needs an item created earlier in the same pass`,
  "POST /api/spaces/:id/occurrences": () => `${NOT_DRIVEN}needs an occurrence payload`,
  "POST /api/spaces/:id/occurrences/batch": () => `${NOT_DRIVEN}needs an occurrence payload`,
  "PATCH /api/spaces/:id/occurrences/:occurrence_id": () => `${NOT_DRIVEN}needs an occurrence payload`,
  "DELETE /api/spaces/:id/occurrences/:occurrence_id": () => `${NOT_DRIVEN}needs an occurrence created earlier in the same pass`,
  "POST /api/spaces/:id/edges": () => `${NOT_DRIVEN}needs two items of one space`,
  "PATCH /api/spaces/:id/edges/:edge_id": () => `${NOT_DRIVEN}needs an edge`,
  "DELETE /api/spaces/:id/edges/:edge_id": () => `${NOT_DRIVEN}needs an edge created earlier in the same pass`,
  "POST /api/spaces/:id/seed": (fx) => fx.space
    ? [post("largest umbrella subtree", `/api/spaces/${fx.space}/seed`, { predicate: { type: "parent_subtree", issue_id: fx.umbrella } })]
    : [],
  "POST /api/spaces/:id/blocks": () => `${NOT_DRIVEN}needs a block payload`,
  "PATCH /api/spaces/:id/blocks/:block_id": () => `${NOT_DRIVEN}needs a block payload`,
  "DELETE /api/spaces/:id/blocks/:block_id": () => `${NOT_DRIVEN}needs a block created earlier in the same pass`,
  "POST /api/spaces/:id/items/:item_id/detach-blocks": () => `${NOT_DRIVEN}needs an item with blocks`,
  "POST /api/spaces/documents/import": () => "imports document bytes from a git commit or Mandible custody",
  "POST /api/spaces/:id/history/:history_id/import": () => "imports document bytes from Mandible custody",

  "POST /api/briefing-destination-routes": (fx) => [post("re-apply current routes", "/api/briefing-destination-routes", destinationRouteManifest(fx))],
  "POST /api/briefing-groups/:groupId/report-placement": () => `${NOT_DRIVEN}briefing publication needs a publisher identity and an operation key`,
  "POST /api/briefings/:briefingId/report-rounds": () => `${NOT_DRIVEN}briefing publication needs a publisher identity and an operation key`,
  "POST /api/briefing-groups": () => `${NOT_DRIVEN}briefing publication needs a publisher identity`,
  "PUT /api/briefing-groups/:groupId/configuration": () => `${NOT_DRIVEN}needs a group configuration payload`,
  "POST /api/briefing-groups/:groupId/updates": () => `${NOT_DRIVEN}needs a proposed bundle`,
  "POST /api/briefing-groups/:groupId/promotions/apply": () => `${NOT_DRIVEN}needs a staged promotion`,
  "POST /api/briefing-groups/:groupId/review-dispositions": () => `${NOT_DRIVEN}needs a review candidate`,
  "POST /api/briefing-groups/:groupId/review-candidates": () => `${NOT_DRIVEN}needs a proposed bundle`,
  "POST /api/briefing-groups/:groupId/destinations": () => `${NOT_DRIVEN}needs a destination artifact`,
  "PATCH /api/briefing-groups/:groupId": () => `${NOT_DRIVEN}needs a group patch payload`,
  "POST /api/briefing-groups/:groupId/archive": () => `${NOT_DRIVEN}archiving the group would change later briefing writes`,
  "POST /api/briefing-groups/:groupId/restore": () => `${NOT_DRIVEN}needs an archived group`,
  "POST /api/briefing-bundles": () => `${NOT_DRIVEN}briefing publication needs a publisher identity`,
  "POST /api/briefing-bundles/:bundleId/briefings": () => `${NOT_DRIVEN}needs a briefing to add`,
  "PATCH /api/briefing-bundles/:bundleId": () => `${NOT_DRIVEN}needs a bundle patch payload`,
  "DELETE /api/briefing-bundles/:bundleId": () => `${NOT_DRIVEN}needs a bundle created earlier in the same pass`,
  "POST /api/briefings": () => `${NOT_DRIVEN}briefing publication needs a publisher identity`,
  "POST /api/briefings/runs": () => `${NOT_DRIVEN}briefing runs need a publisher credential`,
  "PATCH /api/briefings/:briefingId": (fx) => [post("description", `/api/briefings/${fx.briefing}`, { description: `${SWEEP_TAG}` })],
  "POST /api/briefings/:briefingId/archive": () => `${NOT_DRIVEN}archiving the briefing would change later briefing writes`,
  "POST /api/briefings/:briefingId/restore": () => `${NOT_DRIVEN}needs an archived briefing`,
  "POST /api/briefings/:briefingId/rounds/:roundId/answers": () => `${NOT_DRIVEN}needs an open round with questions`,
  "POST /api/briefings/:briefingId/rounds/:roundId/annotations": () => `${NOT_DRIVEN}needs an open round`,
  "POST /api/briefings/:briefingId/rounds/:roundId/submit": () => `${NOT_DRIVEN}needs an open round`,

  "POST /api/operational-incidents/ingest": () => `${NOT_DRIVEN}needs an incident envelope`,
  "POST /api/operational-incidents/:id/acknowledge": () => `${NOT_DRIVEN}needs an unacknowledged incident`,
  "POST /api/operational-incidents/:id/close": () => `${NOT_DRIVEN}needs an open incident at its current revision`,

  "POST /api/projects/repair": () => [post("dry run", "/api/projects/repair", { apply: false })],
  "POST /api/projects/checkouts": () => "registers a checkout root on disk",
  "POST /api/projects/:ref/checkouts": () => "registers a checkout root on disk",
  "PATCH /api/projects/:ref/access": (fx) => [post("unrestricted", `/api/projects/${fx.projectKey}/access`, { restricted: false })],
  "POST /api/projects": () => [post("new project", "/api/projects", (pass: number) => ({ project_key: `${SWEEP_TAG}-${pass}`, display_name: `${SWEEP_TAG} ${pass}` }))],
  "PATCH /api/projects/:ref": (fx) => [post("display name", `/api/projects/${fx.projectKey}`, { display_name: fx.projectDisplay })],

  "POST /api/conversations/ingest": () => "parses provider log files in the live home directory",
  "PATCH /api/conversations/:id": (fx) => [post("star", `/api/conversations/${fx.bigConversation}`, { starred: true })],
  "POST /api/chat-attachments": () => "stores attachment bytes outside the ledger",

  "PUT /api/settings/:key": () => "some keys also write the dotfiles configuration",
  "PUT /api/settings/instructions-delivery": () => "exports instruction files to their delivery targets",
  "PUT /api/user-settings/:key": () => `${NOT_DRIVEN}needs a per-user setting key`,
  "PUT /api/host-preferences/chat-shown-projects": () => `${NOT_DRIVEN}needs the preference's current revision`,
  "PUT /api/host-preferences/sidebar-order": () => `${NOT_DRIVEN}needs the preference's current revision`,
  "PUT /api/host-preferences/app-theme": () => `${NOT_DRIVEN}needs the preference's current revision`,

  "POST /api/providers/register": () => `${NOT_DRIVEN}the snapshot holds no provider to register again`,
  "POST /api/providers/register-manifest": () => `${NOT_DRIVEN}the snapshot holds no provider manifest`,
  "POST /api/provider-manifests/ingest": () => `${NOT_DRIVEN}the snapshot holds no provider manifest`,

  "POST /api/artifacts/ingest": () => "reads files from a checkout path",
  "POST /api/artifacts/plan": () => "plans a path in a live checkout, reading its files and git state",
  "POST /api/artifacts/snapshot": () => "captures bytes from a path",
  "POST /api/artifacts/associations": () => `${NOT_DRIVEN}needs an association payload`,
  "POST /api/artifacts/link": () => `${NOT_DRIVEN}needs a link payload`,
  "POST /api/artifacts/check": (fx) => [post("most-versioned artifact", "/api/artifacts/check", { refs: [fx.artifact] })],
  "POST /api/artifacts/drafts": (fx) => [post("draft", "/api/artifacts/drafts", { ref: fx.artifact, content: `# ${SWEEP_TAG} draft\n` })],
  "POST /api/artifacts/drafts/rebase": (fx) => [post("rebase", "/api/artifacts/drafts/rebase", { ref: fx.artifact })],
  "POST /api/artifacts/drafts/publish": () => `${NOT_DRIVEN}publishing consumes the draft the delete route needs`,
  "DELETE /api/artifacts/drafts": (fx) => [req(`/api/artifacts/drafts?ref=${enc(fx.artifact)}`)],
  "POST /api/artifacts/versions": () => `${NOT_DRIVEN}needs a version payload`,
  "POST /api/artifacts/source/move": () => `${NOT_DRIVEN}needs a source to move to`,
  "POST /api/artifacts/bundles": () => `${NOT_DRIVEN}needs bundle members`,
  "POST /api/artifacts/bundles/:id/members": () => `${NOT_DRIVEN}needs a bundle`,
  "POST /api/knowledge-backrefs": () => `${NOT_DRIVEN}needs a backref payload`,
  "POST /api/artifacts/:id/knowledge-backrefs": () => `${NOT_DRIVEN}needs a backref payload`,

  "POST /api/auth/request": () => "submits a merge request for a live branch",
  "POST /api/auth/request/:id/actions": () => AUTH_TRANSITION,
  "PUT /api/auth/request/:id/actions/:actionId": () => AUTH_TRANSITION,
  "DELETE /api/auth/request/:id/actions/:actionId": () => AUTH_TRANSITION,
  "POST /api/auth/request/:id/actions/:actionId/veto": () => AUTH_TRANSITION,
  "PUT /api/auth/request/:id": () => AUTH_TRANSITION,
  "POST /api/auth/request/:id/withdraw": () => AUTH_TRANSITION,
  "POST /api/auth/request/:id/reject": () => AUTH_TRANSITION,
  "POST /api/auth/request/:id/skip": () => AUTH_TRANSITION,
  "POST /api/auth/request/:id/retry": () => AUTH_TRANSITION,
  "POST /api/auth/request/:id/requeue": () => AUTH_TRANSITION,
  "POST /api/users/operator/signing-key": () => "registers an operator signing key (auth:credentials)",
  "POST /api/users/setup": () => "provisions user credentials (auth:credentials on a preview)",

  "PUT /api/work/repos/:id": (fx) => [post("no-op update", `/api/work/repos/${fx.workRepo}`, {})],
  "POST /api/work/repos/add": () => "scans a repository on disk with git",
  "DELETE /api/work/repos/:id": () => "removes a repository's preview files",
};

function req(url: string): SweepRequest {
  return { label: url, url };
}
function post(label: string, url: PerPass<string>, body: PerPass<unknown>): SweepRequest {
  return { label, url, body };
}
function enc(value: string): string {
  return encodeURIComponent(value);
}
function skip(reason: string): Plan {
  return { kind: "skip", reason };
}

function timelineRequests(fx: Fixtures): SweepRequest[] {
  const state = DEFAULT_TIMELINE_VIEW_STATE;
  const body = (includeClosed: boolean) => ({
    project_ref: fx.projectKey,
    root_policy: state.rootPolicy,
    explicit_root_issue_ids: state.explicitRootIssueIds,
    promoted_root_issue_ids: state.promotedRootIssueIds,
    expanded_event_ids: state.expandedEventIds,
    expanded_paths: state.expandedPaths,
    include_closed: includeClosed,
    event_kinds: state.visibleEventTypes,
    depth: 1,
    root_specs: [],
  });
  return [
    { label: "default view", url: "/api/timeline/project", body: body(false) },
    { label: "include closed", url: "/api/timeline/project", body: body(true) },
  ];
}


export function planRoute(route: CatalogRoute, allowedEffects: Set<string>, fx: Fixtures): Plan | { kind: "unclassified"; reason: string } {
  const key = `${route.method} ${route.path}`;
  if (only && !only.test(route.path)) return skip(`excluded by --only ${only.source}`);
  const missing = (route.effects ?? []).filter((effect) => !allowedEffects.has(effect));
  if (missing.length > 0) return skip(`needs ${missing.join(", ")}, which a preview cannot hold`);
  const entry = READS[key] ?? WRITES[key];
  if (entry) {
    try {
      const requests = entry(fx);
      if (typeof requests === "string") return skip(requests);
      return requests.length > 0 ? { kind: "exercise", requests } : skip("the snapshot holds no entity to name");
    } catch (error) {
      if (error instanceof MissingFixture) return skip(error.message);
      throw error;
    }
  }
  if (route.method !== "GET") return { kind: "unclassified", reason: "non-GET route; give it requests or a skip reason in WRITES" };
  if (route.path.includes(":")) return { kind: "unclassified", reason: "GET route with path parameters; give it requests in READS" };
  return { kind: "exercise", requests: [req(route.path)] };
}

// --- fixtures --------------------------------------------------------------

type Fixtures = ReturnType<typeof readFixtures>;

class MissingFixture extends Error {
  constructor(label: string) {
    super(`no ${label} in the ledger`);
    this.name = "MissingFixture";
  }
}

function fixtureRows<T>(label: string, rows: T[], minimum = 1): T[] {
  if (rows.length < minimum) throw new MissingFixture(label);
  return rows;
}

function destinationRouteManifest(fx: Fixtures) {
  if (!fx.routeManifest?.routes.length) throw new MissingFixture("briefing destination routes");
  return fx.routeManifest;
}

/** Real entity identifiers, resolved once on first use, preferring the heaviest instance of each kind. */
export function readFixtures(dbPath: string) {
  const lazy = <T>(read: (db: SqliteDatabase) => T): (() => T) => {
    let cached: { value: T } | { missing: MissingFixture } | undefined;
    return () => {
      if (cached) {
        if ("missing" in cached) throw cached.missing;
        return cached.value;
      }
      const db = new SqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
      try {
        const value = read(db);
        cached = { value };
        return value;
      } catch (error) {
        if (error instanceof MissingFixture) cached = { missing: error };
        throw error;
      } finally {
        db.close();
      }
    };
  };
  const one = <T>(db: SqliteDatabase, label: string, sql: string, ...params: unknown[]): T => {
    const row = db.prepare(sql).get(...params) as T | undefined;
    if (row === undefined) throw new MissingFixture(label);
    return row;
  };
  const maybe = <T>(db: SqliteDatabase, sql: string, ...params: unknown[]): T | null => (db.prepare(sql).get(...params) as T | undefined) ?? null;
  const project = lazy((db) => one<{ id: string; project_key: string; display_name: string | null }>(db, "project", `
      SELECT p.id, p.project_key, p.display_name FROM ledger_projects p JOIN ledger_issues i ON i.project_id = p.id
      WHERE p.project_key != '' GROUP BY p.id ORDER BY count(*) DESC LIMIT 1`));
  const checkout = lazy((db) => one<{ work_repo_id: string; root: string }>(db, "checkout", `
      SELECT work_repo_id, root FROM ledger_project_checkouts WHERE project_id = ? AND work_repo_id IS NOT NULL
      ORDER BY length(root) LIMIT 1`, project().id));
  const issue = lazy((db) => one<{ id: string; short_id: string }>(db, "issue", `
      SELECT i.id, i.short_id FROM ledger_issues i JOIN ledger_comments c ON c.issue_id = i.id
      WHERE i.project_id = ? AND i.short_id != '' GROUP BY i.id ORDER BY count(*) DESC LIMIT 1`, project().id));
  const umbrella = lazy((db) => one<{ id: string }>(db, "umbrella", `
      SELECT i.id FROM ledger_issues i JOIN ledger_issue_relationships r ON r.source_issue_id = i.id
      WHERE i.kind = 'umbrella' AND r.relationship_type = 'parent_child' GROUP BY i.id ORDER BY count(*) DESC LIMIT 1`));
  const umbrellaChildren = lazy((db) => (db.prepare(`
      SELECT target_issue_id FROM ledger_issue_relationships WHERE source_issue_id = ? AND relationship_type = 'parent_child'
      ORDER BY created_at LIMIT 3`).all(umbrella().id) as { target_issue_id: string }[]).map((row) => row.target_issue_id));
  const comment = lazy((db) => one<{ entity_id: string }>(db, "comment", `
      SELECT entity_id FROM ledger_body_revisions WHERE entity_type = 'comment_body'
      GROUP BY entity_id ORDER BY count(*) DESC LIMIT 1`));
  const bodyRevision = lazy((db) => one<{ id: string }>(db, "body revision", `
      SELECT id FROM ledger_body_revisions WHERE entity_type = 'issue_body' AND issue_id = ? ORDER BY revision_no DESC LIMIT 1`, issue().id));
  const searchWord = "daemon";
  const authRequest = lazy((db) => one<{ id: string }>(db, "auth request", `
      SELECT r.id FROM auth_requests r JOIN auth_request_actions a ON a.auth_request_id = r.id
      GROUP BY r.id ORDER BY count(*) DESC, r.created_at DESC LIMIT 1`));
  const acceptedAuthRequest = lazy((db) => one<{ request_id: string }>(db, "accepted auth request", `
      SELECT auth_request_id AS request_id FROM auth_candidate_acceptances ORDER BY started_at DESC LIMIT 1`));
  const clearance = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM auth_clearances ORDER BY issued_at DESC LIMIT 1"));
  const branch = lazy((db) => one<{ branch: string }>(db, "branch", `
      SELECT branch FROM branches WHERE repo_root = ? AND is_worktree = 1 ORDER BY updated_at DESC LIMIT 1`, checkout().root));
  const workUnit = lazy((db) => one<{ id: string; repo_id: string; branch: string }>(db, "work unit", `
      SELECT id, repo_id, branch FROM work_units WHERE branch IS NOT NULL ORDER BY created_at DESC LIMIT 1`));
  const session = lazy((db) => one<{ id: string; pid: number | null }>(db, "session", `
      SELECT s.id, s.pid FROM sessions s LEFT JOIN sessions c ON c.parent_id = s.id
      GROUP BY s.id ORDER BY count(c.id) DESC, s.updated_at DESC LIMIT 1`));
  const pidSession = lazy((db) => one<{ pid: number }>(db, "session pid", "SELECT pid FROM sessions WHERE pid IS NOT NULL ORDER BY updated_at DESC LIMIT 1"));
  const providerSession = lazy((db) => one<{ session_id: string }>(db, "provider session", `
      SELECT session_id FROM conversations ORDER BY started_at DESC LIMIT 1`));
  const provider = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM providers ORDER BY updated_at DESC LIMIT 1"));
  const artifact = lazy((db) => one<{ id: string }>(db, "artifact", "SELECT id FROM artifact ORDER BY version_count DESC, updated_at DESC LIMIT 1"));
  const versions = lazy((db) => {
    const value = db.prepare("SELECT id FROM artifact_version WHERE artifact_id = ? ORDER BY version_no DESC LIMIT 2")
      .all(artifact().id) as { id: string }[];
    if (value.length < 2) throw new MissingFixture("artifact versions");
    return value;
  });
  const bigConversations = lazy((db) => {
    const value = (db.prepare(`
      SELECT c.id, c.session_id, ${INDEXED_SOURCE_COLUMNS} ${INDEXED_SOURCE_JOINS}
       AND c.started_at >= datetime('now', '-3 days')
       ORDER BY c.block_count DESC LIMIT 200`).all({ idle_before: Date.now() - FIXTURE_IDLE_MS }) as (IndexedSourceRow & { id: string; session_id: string })[])
      .filter(sourceIsIndexed).slice(0, 1);
    if (value.length === 0) throw new MissingFixture("conversation");
    return value;
  });
  const recentConversation = lazy((db) => {
    const value = (db.prepare(`
      SELECT c.id, ${INDEXED_SOURCE_COLUMNS} ${INDEXED_SOURCE_JOINS}
       AND c.parent_conversation_id IS NULL ORDER BY c.started_at DESC LIMIT 200`)
      .all({ idle_before: Date.now() - FIXTURE_IDLE_MS }) as (IndexedSourceRow & { id: string })[]).find(sourceIsIndexed);
    if (!value) throw new MissingFixture("recent conversation");
    return value;
  });
  const consoleSession = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM console_sessions ORDER BY updated_at DESC LIMIT 1"));
  const spawn = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM conversation_spawn_requests ORDER BY updated_at DESC LIMIT 1"));
  const space = lazy((db) => maybe<{ id: string }>(db, `
      SELECT s.id FROM spaces s LEFT JOIN space_items i ON i.space_id = s.id GROUP BY s.id ORDER BY count(i.space_id) DESC LIMIT 1`));
  const spaceItem = lazy((db) => {
    const selected = space();
    return selected ? maybe<{ id: string }>(db, "SELECT id FROM space_items WHERE space_id = ? ORDER BY updated_at DESC LIMIT 1", selected.id) : null;
  });
  const webhookEvents = lazy((db) => (db.prepare("SELECT id FROM webhook_events WHERE status = 'pending' ORDER BY id LIMIT ?").all(passes) as { id: string }[])
      .map((row) => row.id));
  const authResults = (db: SqliteDatabase, column: string) => (db.prepare(`
      SELECT id FROM auth_requests WHERE ${column} IS NULL AND status IN ('approved', 'rejected', 'completed', 'failed')
      ORDER BY updated_at DESC LIMIT ?`).all(passes) as { id: string }[]).map((row) => row.id);
  const undeliveredAuthResults = lazy((db) => authResults(db, "delivered_at"));
  const unacknowledgedAuthResults = lazy((db) => authResults(db, "acknowledged_by"));
  const soloIssue = lazy((db) => one<{ id: string }>(db, "issue in a single-checkout project", `
      SELECT i.id FROM ledger_issues i JOIN ledger_project_checkouts c ON c.project_id = i.project_id
      GROUP BY i.id HAVING count(*) = 1 ORDER BY max(i.updated_at) DESC LIMIT 1`));
  const documentSpace = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM spaces WHERE default_renderer = 'document' ORDER BY updated_at DESC LIMIT 1"));
  const routeKey = lazy((db) => maybe<{ route_key: string }>(db, "SELECT route_key FROM briefing_destination_routes ORDER BY updated_at DESC LIMIT 1"));
  const briefingGroup = lazy((db) => one<{ id: string }>(db, "briefing group", "SELECT id FROM briefing_groups WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 1"));
  const briefingBundle = lazy((db) => one<{ id: string }>(db, "briefing bundle", `
      SELECT b.id FROM briefing_bundles b JOIN briefing_bundle_members m ON m.bundle_id = b.id GROUP BY b.id ORDER BY count(*) DESC LIMIT 1`));
  const briefing = lazy((db) => one<{ id: string }>(db, "briefing", "SELECT id FROM briefings ORDER BY round_count DESC, updated_at DESC LIMIT 1"));
  const submission = lazy((db) => maybe<{ id: string; round: string; briefing: string }>(db, `
      SELECT id, round_id AS round, briefing_id AS briefing FROM briefing_submissions ORDER BY created_at DESC LIMIT 1`));
  const reminder = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM managed_tasks ORDER BY updated_at DESC LIMIT 1"));
  const workflow = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM workflow_runs ORDER BY updated_at DESC LIMIT 1"));
  const attachment = lazy((db) => maybe<{ id: string }>(db, "SELECT id FROM chat_attachment_files ORDER BY created_at DESC LIMIT 1"));
  const settingKeys = lazy((db) => fixtureRows("generic settings keys",
    (db.prepare("SELECT key FROM settings ORDER BY length(value) DESC").all() as { key: string }[])
      .map((row) => row.key).filter((key) => !isProtectedIdentitySettingKey(key)).slice(0, 3)));

  return {
    get project() { return project().id; },
    get projectKey() { return project().project_key; },
    get projectDisplay() { return project().display_name ?? project().project_key; },
    get checkoutRoot() { return checkout().root; },
    get workRepo() { return checkout().work_repo_id; },
    get issueRepo() { return checkout().work_repo_id; },
    get issue() { return issue().id; },
    get issueShort() { return issue().short_id; },
    get umbrella() { return umbrella().id; },
    get umbrellaChildren() { return umbrellaChildren(); },
    get comment() { return comment().entity_id; },
    get bodyRevision() { return bodyRevision().id; },
    searchWord,
    get authRequest() { return authRequest().id; },
    get acceptedAuthRequest() { return acceptedAuthRequest().request_id; },
    get clearance() { return clearance()?.id ?? null; },
    get branch() { return branch().branch; },
    get workUnit() { return workUnit().id; },
    get workUnitRepo() { return workUnit().repo_id; },
    get workUnitBranch() { return workUnit().branch; },
    get session() { return session().id; },
    get sessionPid() { return pidSession().pid; },
    get providerSession() { return providerSession().session_id; },
    get provider() { return provider()?.id ?? null; },
    get artifact() { return artifact().id; },
    get artifactRef() { return artifact().id; },
    get artifactVersionA() { return versions()[1].id; },
    get artifactVersionB() { return versions()[0].id; },
    get conversations() { return [...bigConversations().map((row) => row.id), recentConversation().id]; },
    get bigConversation() { return bigConversations()[0].id; },
    get bigConversationSession() { return bigConversations()[0].session_id; },
    get consoleSession() { return consoleSession()?.id ?? null; },
    get spawn() { return spawn()?.id ?? null; },
    get space() { return space()?.id ?? null; },
    get spaceItem() { return spaceItem()?.id ?? null; },
    get webhookEvents() { return webhookEvents(); },
    get undeliveredAuthResults() { return undeliveredAuthResults(); },
    get unacknowledgedAuthResults() { return unacknowledgedAuthResults(); },
    get soloIssue() { return soloIssue().id; },
    get documentSpace() { return documentSpace()?.id ?? null; },
    get routeKey() { return routeKey()?.route_key ?? null; },
    routeManifest: null as ReturnType<typeof routeManifest> | null,
    get briefingGroup() { return briefingGroup().id; },
    get briefingBundle() { return briefingBundle().id; },
    get briefing() { return briefing().id; },
    get submission() { return submission(); },
    get reminder() { return reminder()?.id ?? null; },
    get workflow() { return workflow()?.id ?? null; },
    get attachment() { return attachment()?.id ?? null; },
    get settingKeys() { return settingKeys(); },
  };
}

interface InspectedRoute {
  route_key: string;
  logical_artifact_id: string;
  publication_mode: string;
  heading: string;
  composer_kind: string;
  active_template_version: number;
  templates: { version: number; contribution_template: string; slots: unknown }[];
  limits: unknown;
}

/** The manifest `mandible briefing route plan` would send to reproduce the current routes. */
function routeManifest(routes: InspectedRoute[]) {
  return {
    schema: "mandible-briefing-destination-routes@3",
    routes: routes.map((route) => {
      const template = route.templates.find((candidate) => candidate.version === route.active_template_version);
      if (!template) throw new Error(`route ${route.route_key} has no active template`);
      return {
        route_key: route.route_key,
        logical_artifact_ref: route.logical_artifact_id,
        publication_mode: route.publication_mode,
        heading: route.heading,
        composer_kind: route.composer_kind,
        template,
        limits: route.limits,
      };
    }),
  };
}

// --- daemon ----------------------------------------------------------------

async function snapshot(source: string, target: string) {
  if (!fs.existsSync(source)) throw new Error(`source ledger does not exist: ${source}`);
  const db = new SqliteDatabase(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
}

async function copySqlite(source: string, target: string) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await snapshot(source, target);
  return true;
}

/** Restore only after the preceding daemon has exited, releasing its cache writer lock. */
export function restoreSweepSnapshot(dbSnapshot: string, dbCopy: string, cacheSnapshot: string, conversationsDir: string): void {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbCopy}${suffix}`, { force: true });
  fs.copyFileSync(dbSnapshot, dbCopy);
  fs.rmSync(conversationsDir, { recursive: true, force: true });
  fs.cpSync(cacheSnapshot, conversationsDir, { recursive: true });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

interface Response {
  status: number;
  bytes: number;
  head: string;
}

function socketRequest(socketPath: string, method: string, url: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      socketPath,
      path: url,
      method,
      headers: {
        host: "localhost",
        ...(payload === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
      },
      timeout: timeoutMs,
    }, (response) => {
      let bytes = 0;
      let head = "";
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (head.length < 400) head += chunk.toString("utf8", 0, Math.min(chunk.length, 400 - head.length));
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, bytes, head }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end(payload ?? undefined);
  });
}

async function socketJson<T>(socketPath: string, url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get({ socketPath, path: url, headers: { host: "localhost" } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 200) reject(new Error(`GET ${url}: HTTP ${response.statusCode} ${text.slice(0, 300)}`));
        else resolve(JSON.parse(text) as T);
      });
    }).on("error", reject);
  });
}

async function waitFor<T>(label: string, timeoutMs: number, check: () => Promise<T | null>, daemon: ChildProcess, stderrLog: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`daemon exited (${daemon.exitCode ?? daemon.signalCode}) before ${label}:\n${tail(stderrLog)}`);
    }
    const value = await check().catch(() => null);
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`daemon not ${label} within ${timeoutMs} ms:\n${tail(stderrLog)}`);
}

function tail(file: string) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").slice(-40).join("\n") : "";
}

function stopDaemon(daemon: ChildProcess, timeoutMs: number): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => daemon.kill("SIGKILL"), timeoutMs);
    daemon.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    daemon.kill("SIGTERM");
  });
}

// --- measurement -----------------------------------------------------------

interface Measured {
  trial: number;
  label: string;
  url: string;
  pass: number;
  status: number;
  bytes: number;
  durationMs: number;
  t0: number;
  t1: number;
  worstTurnMs: number;
  error?: string;
}

/**
 * Charge a request with every turn it caused, including background work it
 * started: keep reading until the loop is quiet, so that work neither escapes
 * the sweep nor lands on the next request. A daemon that never goes quiet
 * aborts the sweep.
 */
async function settle(socketPath: string, result: Measured): Promise<number> {
  let worstMs = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const turnMs = await readTurn(socketPath);
    worstMs = Math.max(worstMs, turnMs);
    result.t1 = Date.now();
    if (turnMs < QUIET_MS) return worstMs;
    if (result.t1 - result.t0 > QUIET_DEADLINE_MS) {
      throw new Error(`daemon still blocking ${turnMs} ms turns ${QUIET_DEADLINE_MS / 1000} s after ${result.url}`);
    }
  }
}

/** The daemon's longest event-loop block since the previous read. */
async function readTurn(socketPath: string): Promise<number> {
  const response = await socketRequest(socketPath, "POST", TURN_ROUTE, {});
  if (response.status !== 200) throw new Error(`POST ${TURN_ROUTE}: HTTP ${response.status} ${response.head}`);
  return (JSON.parse(response.head) as { max_turn_ms: number }).max_turn_ms;
}

// --- main ------------------------------------------------------------------

interface Planned {
  route: CatalogRoute;
  plan: Plan | { kind: "unclassified"; reason: string };
  measured: Measured[];
  profile?: string;
}

interface Daemon {
  child: ChildProcess;
  socketPath: string;
  startupMs: number;
}

interface Run {
  root: string;
  dbCopy: string;
  sourceDb: string;
  revision: string;
  env: Record<string, string>;
  stderrLog: string;
  stdoutLog: string;
  profileDir: string;
}

const activeDaemons = new Set<ChildProcess>();
let interrupted = false;

async function startDaemon(run: Run, profile: boolean): Promise<Daemon> {
  if (interrupted) throw new Error("Sweep interrupted");
  if (profile) {
    fs.rmSync(run.profileDir, { recursive: true, force: true });
    fs.mkdirSync(run.profileDir, { recursive: true });
  }
  const stdoutFd = fs.openSync(run.stdoutLog, "a");
  const stderrFd = fs.openSync(run.stderrLog, "a");
  const startedAt = performance.now();
  const child = spawn(bunRuntime(REPO_ROOT), ["src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...sanitizedLauncherEnv(),
      ...run.env,
      ...(profile ? { BUN_OPTIONS: `--cpu-prof --cpu-prof-dir=${run.profileDir}` } : {}),
    },
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  activeDaemons.add(child);
  child.once("exit", () => activeDaemons.delete(child));
  child.once("error", () => activeDaemons.delete(child));
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const socketPath = localApiSocketPath({ role: "preview", instance_id: run.env.MANDIBLE_INSTANCE_ID });
  try {
    await waitFor("ready and warm", READY_TIMEOUT_MS, async () => {
      const value = await socketJson<{ ready?: boolean; warm?: boolean; startup_commit?: { hash?: string } }>(socketPath, "/api/health");
      return value.ready && value.warm ? value : null;
    }, child, run.stderrLog);
  } catch (error) {
    await stopDaemon(child, 30_000);
    throw error;
  }
  return { child, socketPath, startupMs: Math.round(performance.now() - startedAt) };
}

/**
 * One daemon lifetime: start it, record an idle baseline, request every
 * variant of the given routes `passes` times (the first pass is each
 * variant's first call since startup), then stop it.
 */
async function measureSession(run: Run, planned: Planned[], profile: boolean, trial = 0, replay: Planned[] = []) {
  const daemon = await startDaemon(run, profile);
  let stopped = false;
  try {
    await readTurn(daemon.socketPath);
    await new Promise((resolve) => setTimeout(resolve, BASELINE_MS));
    const baselineMs = await readTurn(daemon.socketPath);
    const measure = async (entry: Planned, request: SweepRequest, pass: number, record = true) => {
      if (opts.evict && pass === 1 && record) {
        for (const file of [run.dbCopy, `${run.dbCopy}-wal`]) {
          if (file.endsWith("-wal") && !fs.existsSync(file)) continue;
          const result = evictFileCache(file);
          if (!result.ok) throw result.error;
        }
      }
      await readTurn(daemon.socketPath);
      const t0 = Date.now();
      const started = performance.now();
      const url = typeof request.url === "function" ? request.url(pass) : request.url;
      const result: Measured = { trial, label: request.label, url, pass, status: 0, bytes: 0, durationMs: 0, t0, t1: t0, worstTurnMs: 0 };
      try {
        const body = typeof request.body === "function" ? request.body(pass) : request.body;
        const response = await socketRequest(daemon.socketPath, entry.route.method, url, body);
        result.status = response.status;
        result.bytes = response.bytes;
        if (response.status >= 400) result.error = response.head;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      result.durationMs = Math.round(performance.now() - started);
      result.worstTurnMs = await settle(daemon.socketPath, result);
      if (record) entry.measured.push(result);
      return result;
    };
    const requestsOf = (entry: Planned) => (entry.plan.kind === "exercise" ? entry.plan.requests : []);
    for (const entry of replay) {
      for (let pass = 1; pass <= passes; pass += 1) {
        for (const request of requestsOf(entry)) {
          const result = await measure(entry, request, pass, false);
          if (result.error !== undefined) {
            throw new Error(`Invalid confirmation trial ${trial}: replay ${entry.route.method} ${result.url}, pass ${pass}, HTTP ${result.status}: ${result.error}`);
          }
        }
      }
    }
    const exercised = planned.filter((entry) => entry.plan.kind === "exercise");
    const reads = exercised.filter((candidate) => !isWrite(candidate.route));
    if (opts.evict) {
      // Keep warm reads ahead of the next eviction, which would cool them again.
      for (const entry of reads) {
        for (const request of requestsOf(entry)) {
          for (let pass = 1; pass <= passes; pass += 1) await measure(entry, request, pass);
        }
      }
    } else {
      // Reads run pass by pass, so every read's first call precedes all warm calls.
      for (let pass = 1; pass <= passes; pass += 1) {
        for (const entry of reads) {
          for (const request of requestsOf(entry)) await measure(entry, request, pass);
        }
      }
    }
    // Writes run route by route in WRITES order, so a bulk write such as
    // ack-all cannot consume the entities a later write's second pass needs.
    for (const entry of exercised.filter((candidate) => isWrite(candidate.route)).sort((a, b) => writeOrder(a.route) - writeOrder(b.route))) {
      for (let pass = 1; pass <= passes; pass += 1) {
        for (const request of requestsOf(entry)) await measure(entry, request, pass);
      }
    }
    if (profile) {
      await stopDaemon(daemon.child, 60_000);
      stopped = true;
      attributeProfile(run.profileDir, planned, trial);
    }
    return { startupMs: daemon.startupMs, baselineMs };
  } finally {
    if (!stopped) await stopDaemon(daemon.child, 30_000);
  }
}

/** Each short issue ID's status in the snapshot; missing IDs are absent. */
function openIssueStatus(dbPath: string, shortIds: string[]): Map<string, string> {
  const statuses = new Map<string, string>();
  if (shortIds.length === 0) return statuses;
  const db = new SqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    const lookup = db.prepare("SELECT status FROM ledger_issues WHERE short_id = ?");
    for (const id of shortIds) {
      const row = lookup.get(id) as { status: string } | undefined;
      if (row) statuses.set(id, row.status);
    }
  } finally {
    db.close();
  }
  return statuses;
}

/** Writes run in WRITES order, so one write can rely on an earlier one. */
/**
 * A conversation whose source file has outgrown its index needs a re-parse
 * before it can be read, and a preview has no worker to re-parse it, so its
 * reads answer 503. Fixtures use conversations indexed to the exact size and
 * mtime of their source file, the facts conversation freshness checks, and
 * require at least an hour without changes to avoid active provider logs.
 */
const FIXTURE_IDLE_MS = 60 * 60 * 1_000;
const INDEXED_SOURCE_COLUMNS = "c.source_path, v.byte_length, v.file_mtime_ms, state.byte_offset";
/** Candidates whose recorded facts already qualify, so a row limit cannot exclude every idle one. */
const INDEXED_SOURCE_JOINS = `FROM conversations c
  JOIN conversation_sources s ON s.conversation_id = c.id
  JOIN conversation_source_versions v ON v.id = s.current_version_id
  JOIN conversation_ingest_state state ON state.file_path = c.source_path
  WHERE v.byte_length = state.byte_offset AND v.file_mtime_ms <= @idle_before`;
interface IndexedSourceRow { source_path: string | null; byte_length: number | null; file_mtime_ms: number | null; byte_offset: number | null }
export function sourceIsIndexed(row: IndexedSourceRow): boolean {
  if (!row.source_path) return false;
  try {
    const { byteLength, fileMtimeMs } = numericSourceExtent(fs.statSync(row.source_path, { bigint: true }));
    return byteLength === row.byte_length && byteLength === row.byte_offset && fileMtimeMs === row.file_mtime_ms
      && Date.now() - fileMtimeMs >= FIXTURE_IDLE_MS;
  } catch {
    return false;
  }
}

function writeOrder(route: CatalogRoute): number {
  return Object.keys(WRITES).indexOf(`${route.method} ${route.path}`);
}

function isWrite(route: CatalogRoute): boolean {
  return Boolean(WRITES[`${route.method} ${route.path}`]);
}

async function main() {
  const cpus = os.availableParallelism();
  if (os.loadavg()[0] >= cpus && !opts["ignore-load"]) log("waiting up to 180 s for the 1-minute load average to fall below the core count");
  const load = await waitForLoad({ cpus, readLoad: () => os.loadavg()[0], ...(opts["ignore-load"] ? { maxWaitMs: 0 } : {}) });
  if (load.measurement_start >= cpus) log(`measuring under load ${load.measurement_start.toFixed(2)} on ${cpus} cores; fresh trials will confirm suspected offenders`);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const workRoot = path.resolve(opts["work-root"] ?? path.join(os.homedir(), ".cache", "mandible", "route-cost-sweep"));
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(workRoot, `run-${stamp}-`));
  const dbCopy = path.join(root, "mandible.db");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  const cleanup = () => {
    if (!opts.keep) fs.rmSync(root, { recursive: true, force: true });
    else log(`kept ${root}`);
  };
  const interrupt = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    void Promise.all([...activeDaemons].map((daemon) => stopDaemon(daemon, 2_000)))
      .then(() => {
        cleanup();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const snapshotStarted = performance.now();
    await snapshot(sourceDb, dbCopy);
    sanitizePreviewDatabase(dbCopy);
    const conversationsDir = path.join(root, "conversations");
    await seedProjectedConversationStructureCache({
      sourceCache: path.join(os.homedir(), ".cache", "mandible", "conversations", "structure.db"),
      targetCache: path.join(conversationsDir, "structure.db"),
      projectedDb: dbCopy,
    });
    await copySqlite(path.join(os.homedir(), ".cache", "mandible", "conversations", "search-cache.db"), path.join(conversationsDir, "search-cache.db"));
    const cacheSnapshot = path.join(root, "seeded-conversations");
    fs.mkdirSync(conversationsDir, { recursive: true });
    fs.cpSync(conversationsDir, cacheSnapshot, { recursive: true });
    seedPreviewUserPreferences({ previewRoot: root });
    fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
    log(`snapshot of ${sourceDb} in ${Math.round(performance.now() - snapshotStarted)} ms`);

    const port = await freePort();
    const env = previewInstanceEnv({ port, dbCopy, sourceDb, pidFile: path.join(root, "mandible.pid"), generation: revision }) as Record<string, string>;
    env.MANDIBLE_CLIENT_AUTH_DIR = path.join(root, "preview-authority", "client-auth");
    const run: Run = {
      root, dbCopy, sourceDb, revision, env,
      stderrLog: path.join(root, "stderr.log"),
      stdoutLog: path.join(root, "stdout.log"),
      profileDir: path.join(root, "profile"),
    };

    // The catalog and fixtures come from a daemon that is discarded, so the
    // measured daemons start with no route ever having been called.
    const catalogDaemon = await startDaemon(run, false);
    let planned: Planned[];
    try {
      const instance = await socketJson<{ instance: { allowed_effects: string[] }; operations: { routes: CatalogRoute[] } }>(catalogDaemon.socketPath, "/api/instance");
      const allowedEffects = new Set(instance.instance.allowed_effects);
      const fixtures = readFixtures(dbCopy);
      fixtures.routeManifest = routeManifest(
        (await socketJson<{ routes?: InspectedRoute[] }>(catalogDaemon.socketPath, "/api/briefing-destination-routes")).routes ?? [],
      );
      planned = instance.operations.routes.map((route) => ({ route, plan: planRoute(route, allowedEffects, fixtures), measured: [] }));
    } finally {
      await stopDaemon(catalogDaemon.child, 30_000);
    }

    const exercised = planned.filter((entry) => entry.plan.kind === "exercise")
      .sort((a, b) => writeOrder(a.route) - writeOrder(b.route));
    const readSnapshot = path.join(root, "before-measurement.db");
    await snapshot(dbCopy, readSnapshot);
    const sessions = opts["fresh-each"]
      ? await sequential(exercised.map((entry) => () => measureSession(run, [entry], opts["cpu-prof"]!)))
      : [await measureSession(run, planned, opts["cpu-prof"]!)];
    log(`measured ${exercised.length} routes over ${sessions.length} daemon start(s)`);

    const trialsOf = (entry: Planned) => [...new Set(entry.measured.map((reading) => reading.trial))]
      .map((trial) => entry.measured.filter((reading) => reading.trial === trial));
    const suspects = opts.evict ? [] : exercised.filter((entry) => judgeRoute(trialsOf(entry), thresholdMs).overBudget);
    // Checkpoint before retries: exception validity belongs to the main snapshot.
    const exceptionIssues = openIssueStatus(dbCopy, Object.values(BUDGET_EXCEPTIONS).map((entry) => entry.issue));
    const writesByKey = new Map(exercised.filter((entry) => isWrite(entry.route))
      .map((entry) => [`${entry.route.method} ${entry.route.path}`, entry]));
    for (const entry of suspects) {
      const replay = isWrite(entry.route)
        ? writeReplayPlan(Object.keys(WRITES), [...writesByKey.keys()], `${entry.route.method} ${entry.route.path}`)
          .map((key) => writesByKey.get(key)!)
        : [];
      log(`confirming ${entry.route.method} ${entry.route.path} in ${CONFIRMATION_TRIALS} fresh trials`);
      for (let trial = 1; trial <= CONFIRMATION_TRIALS; trial += 1) {
        restoreSweepSnapshot(readSnapshot, dbCopy, cacheSnapshot, conversationsDir);
        sessions.push(await measureSession(run, [entry], opts["cpu-prof"]!, trial, replay));
      }
    }

    const routeResult = (entry: Planned) => {
      return { entry, ...judgeRoute(trialsOf(entry), thresholdMs) };
    };
    const measuredRoutes = exercised.map(routeResult).sort((a, b) => b.worstMs - a.worstMs);
    const overBudget = measuredRoutes.filter((result) => result.worstMs >= thresholdMs);
    const exceptionFor = (route: CatalogRoute) => {
      const exception = BUDGET_EXCEPTIONS[`${route.method} ${route.path}`];
      return exception && exceptionIssues.get(exception.issue) === "open" ? exception : null;
    };
    const offenders = overBudget.filter((result) => !exceptionFor(result.entry.route));
    const excepted = overBudget.filter((result) => exceptionFor(result.entry.route));
    const exceptionProblems = Object.entries(BUDGET_EXCEPTIONS).flatMap(([key, { issue }]) => {
      const status = exceptionIssues.get(issue);
      if (status !== "open") return [{ route: key, issue, problem: status ? `issue is ${status}` : "issue not found" }];
      const measured = measuredRoutes.find((result) => `${result.entry.route.method} ${result.entry.route.path}` === key);
      if (measured && measured.worstMs < thresholdMs) return [{ route: key, issue, problem: `within budget (${measured.worstMs} ms); remove the exception` }];
      return [];
    });
    const failedRequests = exercised.flatMap((entry) => entry.measured.filter((result) => result.error !== undefined));
    const unclassified = planned.filter((entry) => entry.plan.kind === "unclassified");
    const skipped = planned.filter((entry) => entry.plan.kind === "skip");

    const describeWorst = (requests: Measured[]) => {
      const pick = requests.reduce((a, b) => (b.worstTurnMs > a.worstTurnMs ? b : a));
      return { label: pick.label, trial: pick.trial, pass: pick.pass, duration_ms: pick.durationMs, bytes: pick.bytes };
    };
    const describeOffender = ({ entry, firstCallMs, warmMs }: ReturnType<typeof routeResult>) => ({
      method: entry.route.method,
      path: entry.route.path,
      first_call_turn_ms: firstCallMs,
      warm_turn_ms: warmMs,
      worst_request: describeWorst(entry.measured),
      profile: entry.profile ?? null,
    });
    const loadEnd = os.loadavg()[0];
    const report = {
      schema: "mandible-route-cost-sweep@2",
      revision,
      source_db: sourceDb,
      threshold_ms: thresholdMs,
      stall_budget_ms: EVENT_LOOP_STALL_BUDGET_MS,
      passes,
      fresh_each: Boolean(opts["fresh-each"]),
      evict: Boolean(opts.evict),
      timing_gate: !opts.evict,
      confirmation_trials: opts.evict ? 0 : CONFIRMATION_TRIALS,
      judging_rule: opts.evict ? "report only; OS cache evicted before each first call" : "same call kind reaches threshold in main and every confirmation trial",
      load: { ...load, end: loadEnd },
      daemon_startup_ms: sessions.map((session) => session.startupMs),
      idle_baseline_ms: Math.max(...sessions.map((session) => session.baselineMs)),
      counts: {
        routes: planned.length,
        measured: exercised.length,
        skipped: skipped.length,
        unclassified: unclassified.length,
        requests: exercised.reduce((sum, entry) => sum + entry.measured.length, 0),
        failed_requests: failedRequests.length,
        offenders: offenders.length,
        excepted: excepted.length,
        remeasured: suspects.length,
      },
      offenders: offenders.map(describeOffender),
      excepted: excepted.map((result) => ({ ...describeOffender(result), issue: exceptionFor(result.entry.route)!.issue })),
      exception_problems: exceptionProblems,
      unclassified: unclassified.map(({ route, plan }) => ({ method: route.method, path: route.path, reason: (plan as { reason: string }).reason })),
      failed_requests: failedRequests.map(({ label, url, trial, pass, status, error }) => ({ label, url, trial, pass, status, error })),
      skipped: skipped.map(({ route, plan }) => ({ method: route.method, path: route.path, reason: (plan as { reason: string }).reason })),
      measured: measuredRoutes.map(({ entry, firstCallMs, warmMs }) => ({
        method: entry.route.method,
        path: entry.route.path,
        first_call_turn_ms: firstCallMs,
        cold_cache_turn_ms: opts.evict ? firstCallMs : null,
        warm_turn_ms: warmMs,
        trials: trialsOf(entry).map((readings) => {
          const turns = trialTurns(readings);
          return { trial: readings[0].trial, first_call_turn_ms: turns.firstCallMs, warm_turn_ms: turns.warmMs };
        }),
        requests: entry.measured.map(({ label, trial, pass, status, bytes, durationMs, worstTurnMs, t0, t1 }) => ({ label, trial, pass, status, bytes, duration_ms: durationMs, settled_ms: t1 - t0, worst_turn_ms: worstTurnMs })),
      })),
      root: opts.keep ? root : null,
    };

    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return (opts.evict || (offenders.length === 0 && exceptionProblems.length === 0)) && unclassified.length === 0 && failedRequests.length === 0 ? 0 : 1;
  } finally {
    if (!interrupted) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      cleanup();
    }
  }
}

async function sequential<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = [];
  for (const task of tasks) results.push(await task());
  return results;
}

function attributeProfile(profileDir: string, planned: Planned[], trial: number) {
  const profile = fs.readdirSync(profileDir).find((name) => name.endsWith(".cpuprofile"));
  if (!profile) throw new Error(`--cpu-prof: the daemon wrote no profile to ${profileDir}`);
  for (const entry of planned) {
    const readings = entry.measured.filter((reading) => reading.trial === trial);
    if (readings.length === 0) continue;
    const pick = readings.reduce((a, b) => (b.worstTurnMs > a.worstTurnMs ? b : a));
    if (pick.worstTurnMs < thresholdMs) continue;
    const result = spawnSync(process.execPath, [
      path.join(REPO_ROOT, "scripts", "cpuprofile-windows.mjs"),
      path.join(profileDir, profile),
      "--window", `${new Date(pick.t0).toISOString()},${pick.t1 - pick.t0 + SETTLE_MS}`,
      "--top", "8",
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    entry.profile = (result.stdout || result.stderr).trim();
  }
}

function printReport(report: Record<string, any>) {
  const lines: string[] = [];
  lines.push(`revision ${report.revision.slice(0, 8)}; load ${report.load.start} -> ${report.load.end} on ${report.load.cpus} cores; threshold ${report.threshold_ms} ms`);
  lines.push(`load wait ${report.load.waited_ms} ms; measurement-start load ${report.load.measurement_start}; ${report.counts.remeasured} routes remeasured in ${report.confirmation_trials} fresh trials each`);
  lines.push(`${report.counts.routes} routes: ${report.counts.measured} measured, ${report.counts.skipped} skipped, ${report.counts.unclassified} unclassified; ${report.counts.requests} requests, ${report.counts.failed_requests} failed`);
  lines.push(`daemon startup ${report.daemon_startup_ms.length === 1 ? report.daemon_startup_ms[0] : `max ${Math.max(...report.daemon_startup_ms)}`} ms; longest idle turn ${report.idle_baseline_ms} ms over ${BASELINE_MS / 1000} s`);
  if (report.evict) lines.push("OS file cache evicted before first calls; timing results are report-only (no confirmation trials or budget gate)");
  lines.push("");
  lines.push(report.offenders.length ? (report.evict ? `over budget (report only; cold-cache / warm):` : `offenders (same call kind >= ${report.threshold_ms} ms in every trial; first call / warm minima):`) : "no offenders");
  for (const offender of report.offenders) {
    lines.push(`  ${String(offender.first_call_turn_ms).padStart(6)} / ${String(offender.warm_turn_ms).padStart(5)} ms  ${offender.method} ${offender.path}   (${offender.worst_request.label}, pass ${offender.worst_request.pass}, ${offender.worst_request.duration_ms} ms, ${offender.worst_request.bytes} B)`);
    if (offender.profile) lines.push(offender.profile.split("\n").map((line: string) => `      ${line}`).join("\n"));
  }
  for (const entry of report.excepted) lines.push(`  excepted ${entry.first_call_turn_ms} / ${entry.warm_turn_ms} ms  ${entry.method} ${entry.path} [issue:${entry.issue}]`);
  for (const entry of report.exception_problems) lines.push(`exception ${entry.route} [issue:${entry.issue}]: ${entry.problem}`);
  for (const entry of report.unclassified) lines.push(`unclassified ${entry.method} ${entry.path}: ${entry.reason}`);
  for (const entry of report.failed_requests) lines.push(`failed ${entry.url} (trial ${entry.trial}, pass ${entry.pass}): ${entry.status} ${String(entry.error).slice(0, 200)}`);
  lines.push("");
  lines.push(report.evict ? "measured (cold-cache / warm turns), worst first:" : "measured (minimum across trials of first-call / warm maxima), worst first:");
  for (const entry of (report.evict ? report.measured : report.measured.slice(0, 30))) lines.push(`  ${String(entry.first_call_turn_ms).padStart(6)} / ${String(entry.warm_turn_ms).padStart(5)} ms  ${entry.method} ${entry.path}`);
  for (const entry of report.measured.filter((entry: { trials: unknown[] }) => entry.trials.length > 1)) {
    lines.push(`  trials ${entry.method} ${entry.path}: ${entry.trials.map((trial: { trial: number; first_call_turn_ms: number; warm_turn_ms: number }) => `${trial.trial}: ${trial.first_call_turn_ms}/${trial.warm_turn_ms} ms`).join(", ")}`);
  }
  lines.push("");
  lines.push("skipped:");
  for (const entry of report.skipped) lines.push(`  ${entry.method} ${entry.path}: ${entry.reason}`);
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  main().then((code) => { if (!interrupted) process.exit(code); }, (error) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    if (!interrupted) process.exit(2);
  });
}

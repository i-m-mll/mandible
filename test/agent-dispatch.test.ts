import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchAgent, previewAgentDispatch } from "../src/agent-dispatch.js";
import { getDbPath } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { closeOperationalIncident, getOperationalIncident, raiseDaemonIncident } from "../src/operational-incidents.js";
import { createLedgerIssue, createMigratedDbWithSeeds } from "./helpers/ledger-fixtures.js";
import { useCommandProbe, useStubCommand } from "./helpers/event-loop-blocking.js";

describe("agent dispatch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("waits for claude-spawn off the event loop and records the session it started", async () => {
    const { db, seeds } = createMigratedDbWithSeeds({
      setGlobal: true, operator: { slug: "dispatcher", display_name: "Dispatcher" } });
    const project = addProject(db, { project_key: "dispatch", display_name: "Dispatch" });
    const issue = createLedgerIssue(db, { project_id: project.id, title: "Dispatch me" });
    const probe = await useCommandProbe({ "claude-spawn": `printf 'spawn-handle\\nsession_id: spawned-session\\nattach: claude-spawn attach spawn-handle\\n'` });
    vi.stubEnv("MANDIBLE_CLAUDE_SPAWN_BIN", path.join(probe.dir, "claude-spawn"));
    try {
      let outcome: Awaited<ReturnType<typeof dispatchAgent>> | undefined;
      await probe.run(async () => {
        outcome = await dispatchAgent(db, {
          subject: { kind: "issue", issue_ref: issue.id },
          instruction: "Look into it.",
          actorUserId: seeds.operator!.id,
        });
      });
      expect(outcome?.event).toMatchObject({
        status: "dispatched",
        session_handle: "spawn-handle",
        session_id: "spawned-session",
        attach_command: "claude-spawn attach spawn-handle",
      });
    } finally {
      db.close();
      fs.rmSync(path.join(path.dirname(getDbPath()), "agent-dispatch"), { recursive: true, force: true });
    }
  });

  it("returns an incident to no remediation when its dispatch fails", async () => {
    const { db, seeds } = createMigratedDbWithSeeds({
      setGlobal: true, operator: { slug: "dispatcher", display_name: "Dispatcher" } });
    const { incident_id: incidentId } = raiseDaemonIncident(db, { task: "dispatch-failure", exitClass: "config" });
    const stub = useStubCommand("claude-spawn", "echo 'tmux server unavailable' >&2\nexit 1");
    vi.stubEnv("MANDIBLE_CLAUDE_SPAWN_BIN", path.join(stub.dir, "claude-spawn"));
    try {
      const subject = { kind: "incident" as const, incident_id: incidentId };
      const plan = previewAgentDispatch(db, { subject, instruction: "Fix it.", actorUserId: seeds.operator!.id });
      const outcome = await dispatchAgent(db, {
        subject,
        instruction: "Fix it.",
        actorUserId: seeds.operator!.id,
        expectedPromptSha256: plan.prompt_sha256,
        expectedIncidentTelemetrySha256: plan.incident_telemetry_sha256!,
      });
      expect(outcome.event).toMatchObject({ status: "failed", error: "tmux server unavailable" });
      expect(outcome.incident).toMatchObject({ remediation: "none", resolved: false });
    } finally {
      db.close();
      fs.rmSync(path.join(path.dirname(getDbPath()), "agent-dispatch"), { recursive: true, force: true });
    }
  });

  it("keeps an incident the operator closed while a failing dispatch was spawning", async () => {
    const { db, seeds } = createMigratedDbWithSeeds({
      setGlobal: true, operator: { slug: "dispatcher", display_name: "Dispatcher" } });
    const { incident_id: incidentId } = raiseDaemonIncident(db, { task: "dispatch-race", exitClass: "config" });
    const probe = await useCommandProbe({ "claude-spawn": "echo 'tmux server unavailable' >&2\nexit 1" }, { hold: true });
    vi.stubEnv("MANDIBLE_CLAUDE_SPAWN_BIN", path.join(probe.dir, "claude-spawn"));
    let dispatched: ReturnType<typeof dispatchAgent> | undefined;
    try {
      const subject = { kind: "incident" as const, incident_id: incidentId };
      const plan = previewAgentDispatch(db, { subject, instruction: "Fix it.", actorUserId: seeds.operator!.id });
      dispatched = dispatchAgent(db, {
        subject,
        instruction: "Fix it.",
        actorUserId: seeds.operator!.id,
        expectedPromptSha256: plan.prompt_sha256,
        expectedIncidentTelemetrySha256: plan.incident_telemetry_sha256!,
      });
      await probe.nextInvocation(dispatched);
      const triaging = getOperationalIncident(db, incidentId);
      expect(triaging.remediation).toBe("triaging");
      closeOperationalIncident(db, incidentId, seeds.operator!.id, "Fixed by hand.", triaging.updated_at);
      probe.release();

      const outcome = await dispatched;
      expect(outcome.event).toMatchObject({ status: "failed", error: "tmux server unavailable" });
      expect(outcome.incident).toEqual(getOperationalIncident(db, incidentId));
      expect(outcome.incident).toMatchObject({ remediation: "complete", operator_closed_by_user_id: seeds.operator!.id });
    } finally {
      try {
        await probe.close();
      } finally {
        await dispatched?.catch(() => undefined);
        db.close();
        fs.rmSync(path.join(path.dirname(getDbPath()), "agent-dispatch"), { recursive: true, force: true });
      }
    }
  });
});

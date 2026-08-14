import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxView, type InboxData } from "../ui/src/views/inbox";

afterEach(() => cleanup());

describe("Inbox managed reminder occurrence", () => {
  it("renders actionable provenance without dumping raw evidence JSON and acknowledges it", async () => {
    const onAck = vi.fn(async () => undefined);
    const data: InboxData = {
      continuations: [],
      auth_results: [],
      open_issues: [],
      managed_reminder_occurrences: [{
        id: "remocc_01",
        task_id: "rem_01",
        revision_id: "remrev_01",
        message: "Review the twentieth canonical merge",
        project_id: "prj_01",
        project_key: "mandible",
        predicate: { kind: "auth_merge_count_gte", threshold: 20 },
        payload_digest: "a".repeat(64),
        created_by_user_id: "user_agent",
        fired_by_user_id: "user_system",
        triggering_evidence: {
          kind: "auth_merge_count_gte",
          observed_count: 20,
          latest_completed_at: 1_786_650_000_000,
        },
        created_at: 1_786_650_000_000,
      }],
      total: 1,
    };

    render(
      <InboxView
        data={data}
        loading={false}
        selectedItemId="managed_reminder_occurrence:remocc_01"
        onAckContinuation={async () => undefined}
        onAckAuthResult={async () => undefined}
        onAckManagedReminderOccurrence={onAck}
        onAckAll={async () => undefined}
        onRefresh={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getAllByText("Review the twentieth canonical merge")).toHaveLength(2));
    expect(screen.getAllByText("Reminder").length).toBeGreaterThan(1);
    const detail = document.querySelector(".inbox-detail") as HTMLElement;
    expect(within(detail).getByText("20")).toBeTruthy();
    expect(within(detail).getByText("mandible")).toBeTruthy();
    expect(detail.textContent).not.toContain("observed_count");
    fireEvent.click(within(detail).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(onAck).toHaveBeenCalledWith("remocc_01"));
  });
});

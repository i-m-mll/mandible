import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxView, type InboxData } from "../../ui/src/views/inbox";

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

describe("Inbox shared sidebar header", () => {
  const data: InboxData = {
    continuations: [{
      session_id: "session-1",
      continuation: "Continue the shared header work",
      branch: "feature/header",
      ended_at: "2026-08-19T18:00:00.000Z",
      repo: "mandible",
    }],
    auth_results: [],
    open_issues: [],
    managed_reminder_occurrences: [],
    total: 1,
  };

  function renderInbox(overrides: Partial<Parameters<typeof InboxView>[0]> = {}) {
    const props: Parameters<typeof InboxView>[0] = {
      data,
      loading: false,
      selectedItemId: "continuation:session-1",
      onAckContinuation: async () => undefined,
      onAckAuthResult: async () => undefined,
      onAckManagedReminderOccurrence: async () => undefined,
      onAckAll: async () => undefined,
      onRefresh: () => undefined,
      ...overrides,
    };
    return render(<InboxView {...props} />);
  }

  it("uses the shared adjacent menu and preserves its actions", async () => {
    const onAckAll = vi.fn(async () => undefined);
    const onRefresh = vi.fn();
    const { container } = renderInbox({ onAckAll, onRefresh });

    const header = container.querySelector(".sidebar-search-filter");
    expect(header).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Filter inbox by repo or branch" });
    const trigger = screen.getByRole("button", { name: "Inbox menu" });
    expect(trigger.previousElementSibling?.contains(search)).toBe(true);

    fireEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Date" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Acknowledge All" }));
    await waitFor(() => expect(onAckAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Inbox menu" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Inbox menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("preserves mutation and loading disabled states inside the menu", () => {
    renderInbox({ loading: true, mutationsAllowed: false });
    fireEvent.click(screen.getByRole("button", { name: "Inbox menu" }));

    expect((screen.getByRole("menuitem", { name: "Acknowledge All" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gates individual acknowledgements and never reports an empty result after a failed load", () => {
    const { rerender } = renderInbox({ mutationsAllowed: false });
    const detail = document.querySelector(".inbox-detail") as HTMLElement;
    expect((within(detail).getByRole("button", { name: "Acknowledge" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<InboxView
      data={null}
      loading={false}
      error="Preview request failed"
      selectedItemId={null}
      onAckContinuation={async () => undefined}
      onAckAuthResult={async () => undefined}
      onAckManagedReminderOccurrence={async () => undefined}
      onAckAll={async () => undefined}
      onRefresh={() => undefined}
      mutationsAllowed
    />);
    expect(screen.getByText("Inbox could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("Inbox is clear.")).toBeNull();
    expect(within(document.querySelector(".inbox-detail") as HTMLElement).getByText("Inbox data is unavailable.")).toBeTruthy();
  });

  it("disables agent resume when external process actions are unavailable", () => {
    const workUnit = {
      id: "wu-1",
      issue_id: "issue-123",
      repo_id: "repo-1",
      branch: "feature/copied-preview",
      continuation: "Resume this work",
      continuation_at: "2026-09-01T12:00:00Z",
    } as unknown as import("../../ui/src/api").WorkUnitWithLiveness;
    renderInbox({
      data: {
        continuations: [],
        auth_results: [],
        open_issues: [],
        work_unit_continuations: [workUnit],
        total: 1,
      },
      selectedItemId: "wu_continuation:wu-1",
      externalActionsAllowed: false,
    });

    expect((screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("preserves chip autocomplete and empty-input Backspace removal", () => {
    renderInbox();
    const input = screen.getByRole("textbox", { name: "Filter inbox by repo or branch" });
    fireEvent.input(input, { target: { value: "m" } });
    fireEvent.mouseDown(screen.getByRole("button", { name: "mandible" }));
    expect(screen.getByRole("button", { name: "Remove filter mandible" })).toBeTruthy();

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByRole("button", { name: "Remove filter mandible" })).toBeNull();
  });

  it("removes the bespoke second action row contract", () => {
    const source = readFileSync("ui/src/views/inbox.tsx", "utf8");
    expect(source).toContain("SidebarSearchFilterHeader");
    expect(source).not.toContain("inbox-sidebar__actions-bar");
    expect(source).not.toContain("Sort: Date");
    expect(source).not.toContain(">Ack All<");
  });
});

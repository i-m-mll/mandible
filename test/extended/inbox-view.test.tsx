import { render } from './notice-test-render';
import { establishTestClientAccess } from '../helpers/local-client-access';
import { MAIN_CLI_INSTANCE_RESPONSE } from '../helpers/cli-instance-response';
import { bindTestInstanceCatalog } from '../helpers/instance-operation-fixtures';

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxView, type InboxData } from "../../ui/src/views/inbox";

beforeEach(async () => {
  await establishTestClientAccess();
  bindTestInstanceCatalog(MAIN_CLI_INSTANCE_RESPONSE.instance);
});
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
        instance={MAIN_CLI_INSTANCE_RESPONSE.instance}
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
      instance: MAIN_CLI_INSTANCE_RESPONSE.instance,
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
    const { container } = renderInbox({ onAckAll });

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

  });

  it("preserves mutation and loading disabled states inside the menu", () => {
    renderInbox({ loading: true, instance: { ...MAIN_CLI_INSTANCE_RESPONSE.instance, allowed_effects: ["ledger:read"] } });
    fireEvent.click(screen.getByRole("button", { name: "Inbox menu" }));

    expect((screen.getByRole("menuitem", { name: "Acknowledge All" }) as HTMLButtonElement).disabled).toBe(true);

  });

  it("retries a failed read and disables retry while loading", async () => {
    const onRefresh = vi.fn();
    const view = renderInbox({ data: null, error: "Read failed", onRefresh });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    view.rerender(<InboxView instance={MAIN_CLI_INSTANCE_RESPONSE.instance} data={data}
      loading={true} error="Read failed" onRefresh={onRefresh}
      onAckContinuation={async () => undefined} onAckAuthResult={async () => undefined}
      onAckManagedReminderOccurrence={async () => undefined} onAckAll={async () => undefined} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true));
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

});

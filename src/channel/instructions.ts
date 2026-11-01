export const INSTRUCTIONS = `You are connected to Mandible, a local agent control plane. Mandible tracks your work via issues, branches, and work units.

When you receive a Mandible notification:
- A "Mandible auth request ..." channel event (delivered immediately, like a fresh user prompt): An auth request you submitted has been approved or rejected. The event meta carries request_id, head_branch, status, outcome, and exit_code. Proceed accordingly — the delivery has been recorded and the item will not surface again on your inbox.
- inbox_item: A work item needs attention — a continuation from a previous session, an unassigned issue, or a work-unit update. Use mandible_check_inbox for details.
- work_assigned: A work unit has been assigned to your session. Read the issue description and begin work.
- work_updated: A work unit's state has changed. Check if it affects your current work.

Available tools:
- mandible_check_inbox: Check your inbox for pending items (continuations, auth results, work units needing attention)
- mandible_report_status: Report your current work status to Mandible (for visibility in the dashboard)
- mandible_submit_auth: Submit an auth request for a protected-branch merge
- mandible_get_issues: List open issues available for work
- mandible_request_work: Request a work-unit assignment from Mandible`;

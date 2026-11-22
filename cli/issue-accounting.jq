# What holds a held issue open, as one phrase; mirrors describeHolds in src/contracts.ts.
def holds:
  [
    (if (.open_children | length) > 0 then "open children " + (.open_children | join(", ")) else empty end),
    (if (.unmerged_units | length) > 0 then "work the head does not contain (" + ([.unmerged_units[] | "\(.id[0:8]) on \(.branch // "no branch")"] | join(", ")) + ")" else empty end)
  ] | join(" and ");

def conditional: [.held[] | select(.closes_by != null)];
def held_open: [.held[] | select(.closes_by == null)];

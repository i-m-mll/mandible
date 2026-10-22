# Human-facing identity formatting for Mandible CLI text output.
#
# Prefer server-allocated display refs whenever they exist. The fallback only
# compacts identity families whose short form is already part of the CLI/router
# contract; mutation and JSON paths must continue to use the exact value.
def mandible_short_id:
  if . == null then "-"
  elif type != "string" then tostring
  elif test("^[0-9a-f]{8}-[0-9a-f-]{27}$"; "i") then .[0:8]
  elif test("^[0-9a-f]{64}$"; "i") then .[0:8]
  # Time-ordered ids (ledger `<kind>_<time>_<random>`, `<kind>_<ULID>`) print
  # their time part and seven random characters: ids minted in one
  # millisecond share the time part, so it alone is ambiguous.
  elif test("^[a-z]+_[0-9a-z]{10}_[0-9a-f]{20}$") then .[0:(index("_") + 19)]
  elif test("^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$") then .[0:(index("_") + 18)]
  elif test("^[a-z][a-z0-9-]*_[0-9A-Za-z_-]{12,}$") then
    capture("^(?<prefix>[a-z][a-z0-9-]*_)(?<identity>[0-9A-Za-z_-]+)$")
    | .prefix + (.identity[0:10])
  else .
  end;

def mandible_typed_short_ref:
  if . == null then "-"
  elif type != "string" then tostring
  elif test("^(artifact|artifact-version|artifact-series|artifact-blob):") then
    capture("^(?<prefix>[^:]+:)(?<identity>.+)$")
    | .prefix + (.identity[0:12])
  else mandible_short_id
  end;

# A Briefing's `briefing:<short-id>` ref. Legacy ids store the `briefing:`
# prefix themselves; the ref never repeats it.
def mandible_briefing_ref:
  if . == null then "-"
  elif type != "string" then tostring
  else "briefing:" + (sub("^briefing:"; "") | mandible_short_id)
  end;

def mandible_display_id:
  (.display_id // .short_id // .ref // .normalized_ref // (.id | mandible_short_id));

def mandible_display_ref:
  (.ref // .normalized_ref // .display_id // .short_id // (.id | mandible_typed_short_ref));

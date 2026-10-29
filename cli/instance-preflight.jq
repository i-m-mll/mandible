def instance_metadata_valid:
  (.instance.role | type == "string" and IN("main", "preview", "dev", "test"))
  and (if (.instance | has("allowed_effects")) then
    (.instance.allowed_effects | type == "array" and all(.[]; type == "string"))
  else
    (.instance.operational_mutations | type == "string" and IN("allow", "reject"))
  end);

def operation_catalog_valid:
  .operations.schema == "mandible-operation-catalog@2"
  and .operations.source == "Router.listRoutePolicies"
  and (.operations.runtime.version | type == "string" and length > 0)
  and .operations.runtime.instance_id == .instance.instance_id
  and .operations.runtime.backend_generation == .instance.backend_generation
  and (.operations.routes | type == "array" and all(.[];
    (.operationId | type == "string" and length > 0)
    and (.method | type == "string") and (.path | type == "string")
    and has("operationalMutationCategory")
    and (.operationalMutationCategory == null or (.operationalMutationCategory | type == "string"))
    and (.fileRpc | IN("allow", "deny", "conditional"))
    and (.requestSchema | IN("handler", "zod"))));

def route_matches($pathname):
  split("/") as $template
  | ($pathname | split("/")) as $parts
  | ($template | length) == ($parts | length)
    and all(range(0; $template | length);
      . as $index
      | if ($template[$index] | startswith(":")) then
          $parts[$index] != ""
        else $template[$index] == $parts[$index] end);

def instance_preflight($method; $pathname):
  if (.instance | type) != "object" then empty
  elif ((try instance_metadata_valid catch false) | not) then
    {preflight_error: "instance", category: "operation"}
  elif ((try operation_catalog_valid catch false) | not) then
    {preflight_error: "catalog", category: "operation"}
  else
    (first(.operations.routes[]
      | select(.method == $method and (.path | route_matches($pathname)))) // null) as $route
    | if $route == null then
        {preflight_error: "operation", category: "operation"}
      elif $route.operationalMutationCategory == null or $route.operationalMutationCategory == "" or $route.operationalMutationCategory == "null" then
        {preflight_error: "", category: ""}
      else
        {preflight_error: "", category: $route.operationalMutationCategory,
          role: .instance.role,
          policy: (if (.instance | has("allowed_effects")) then
            if (.instance.allowed_effects | index("maintenance:shared")) != null then "allow" else "reject" end
            else .instance.operational_mutations end),
          db_path: (.instance.db_path // ""), source_db_path: (.instance.source_db_path // "")}
        | if all(.[]; type == "string") then .
          else {preflight_error: "instance", category: $route.operationalMutationCategory} end
      end
  end;

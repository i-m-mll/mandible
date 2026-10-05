import { getDb } from "../db.js";
import { buildOperationalGraph, graphFilterOptions, graphModeCounts } from "../graph/operational.js";
import { graphLayers, selectGraphForDisplay } from "../graph/selection.js";
import {
  firstQueryValue,
  graphSpecForMode,
  modeDescriptors,
  modeFromPreset,
  parseQueryParams,
  presetDescriptors,
} from "../graph/spec.js";
import { getIndexedGraph, projectArtifactPublicValue } from "../provider-artifacts.js";
import type { RouteRegistrar } from "../server.js";
import type { GraphPayload } from "../types.js";

// Bug: 7a141c3 — graph API implementation
// Bug: 50c4afb — typed graph modes for the React Flow graph workspace
// Bug: 22a54d4 — this module owns request parsing, payload assembly, and HTTP
// registration only; graph spec policy, selection, and projection live in src/graph/.

export function registerGraphRoutes(app: RouteRegistrar): void {
  app.get("/api/graph", (req, res) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const params = parseQueryParams(query);
    const spec = params.spec ?? graphSpecForMode(params.mode ?? "issue");
    const mode = params.mode ?? modeFromPreset(spec.preset ?? "issues");
    const providerId = firstQueryValue(query, "provider");
    const root = firstQueryValue(query, "root");
    let selected: ReturnType<typeof selectGraphForDisplay>;

    if (mode === "provider-lineage" || mode === "artifact-lineage" || mode === "provenance") {
      const indexed = getIndexedGraph(getDb(), {
        mode,
        providerId,
        root,
        limit: spec.limit,
      });
      selected = selectGraphForDisplay(indexed.nodes, indexed.edges, spec);
    } else {
      selected = buildOperationalGraph(params);
    }

    const counts = graphModeCounts();
    const payload: GraphPayload = {
      version: 1,
      mode,
      spec,
      nodes: selected.nodes,
      edges: selected.edges,
      modes: modeDescriptors(counts),
      presets: presetDescriptors(),
      node_legend: selected.nodeLegend,
      edge_legend: selected.edgeLegend,
      counts: selected.counts,
      metadata: {
        endpoint_policy: spec.endpoint_policy,
        date_filter: spec.filters.since
          ? {
              since: spec.filters.since,
              issue_time_field: "graph_activity_at",
              issue_time_components: [
                "issue.updated_at",
                "issue.created_at",
                "comments.created_at/updated_at",
                "auth_links.created_at/auth.updated_at/resolved_at",
                "session_links.created_at/last_seen_at",
              ],
              relationship_time_semantics: "endpoint_eligibility",
            }
          : undefined,
      },
      layers: graphLayers(selected.nodes, mode),
      filters: graphFilterOptions(),
      truncated: selected.truncated,
      limit: spec.limit,
      displayed_count: selected.counts.visible_nodes,
      available_count: selected.counts.available_nodes,
    };

    res.json(projectArtifactPublicValue(getDb(), payload));
  }, { operation: { id: "get:/api/graph", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
}

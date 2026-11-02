import type { Db } from "../db.js";
import { listBriefings } from "../feedback/briefings.js";

export function briefingsList(db: Db, { viewer }: {
  viewer: { userId: string; operator: boolean };
}) {
  const briefings = listBriefings(db, viewer) as Array<{ logical_artifact_id: string | null }>;
  return { briefings };
}

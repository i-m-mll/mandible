#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const inheritedExtendedBaselines = new Map([
  ["test/extended/artifact-ingest-pool.test.ts", "2801d65c4724dad369b4bafa06ea59e285a3870533a260740a4e2d1093494f69"],
  ["test/extended/briefing-demo-seed.test.ts", "b7fd6c37afa1c283307f3635b8ccf775f7ce4068876887a83faaeed18682f64a"],
  ["test/extended/auth-history-summary.test.ts", "d9d1d5e9832a1186473f0e0d372e3133cc2303886bf869fe66f8c8f9e25d9909"],
  ["test/extended/conversation-search-route.test.ts", "3bf31d56681edd5f77b52cdfa4f8da9a9e48ef8df1353c1f1505b81204702c07"],
  ["test/extended/inbox-view.test.tsx", "3200e45ed1de1da4b6ec9d05d38c6c1c46a9d46bafd0cb9fcd9355049087aad8"],
  ["test/extended/project-db-snapshot.test.ts", "4e1e14aeea7517ad387d40a1c98e1ffe97cc1fa7cc1015341fdfb6565871d0c5"],
  ["test/extended/rich-chat-pane.test.tsx", "edbd2d1ce4c208c7e0424d12d67bc404f40a835584d727973eee31a3542d65b9"],
  ["test/extended/view-sidebar.test.tsx", "d72c522d2922de4227efde3ef6effc71f295d948514eab695562e0ca941d5e12"],
]);

export function verifyInheritedExtendedBaselines() {
  for (const [file, expectedHash] of inheritedExtendedBaselines) {
    const actualHash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`${file} changed while excluded from test:extended; remove its baseline exclusion and disposition its tests.`);
    }
  }
  process.stdout.write(`Verified ${inheritedExtendedBaselines.size} byte-pinned extended-test exclusions.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyInheritedExtendedBaselines();
}

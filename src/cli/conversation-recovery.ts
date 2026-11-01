#!/usr/bin/env bun
import fs from "node:fs";
import { parseCommand, stringOption, numberOption } from "./grammar.js";
import { withCliReadOnlyDatabase } from "./read-only-database.js";
import { restoreConversationMetadata, reconcileRecoveredConversations, inspectConversationRecovery } from "../conversations/recovery.js";

async function main(): Promise<void> {
  const parsed = parseCommand(["conversation-recovery"], process.argv.slice(2));
  if (parsed.command === "conversation-recovery.restore") {
    const destination = stringOption(parsed, "destination")!;
    const db = restoreConversationMetadata(fs.readFileSync(stringOption(parsed, "metadata-sql")!, "utf8"), destination);
    db.close();
    await reconcileRecoveredConversations(destination);
    await withCliReadOnlyDatabase(destination, async restored => console.log(JSON.stringify(await inspectConversationRecovery(restored, { limit: numberOption(parsed, "limit") }), null, 2)));
  } else {
    await withCliReadOnlyDatabase(stringOption(parsed, "db")!, async db => console.log(JSON.stringify(await inspectConversationRecovery(db, { limit: numberOption(parsed, "limit"), offset: numberOption(parsed, "offset") }), null, 2)));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

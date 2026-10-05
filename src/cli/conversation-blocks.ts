#!/usr/bin/env node
import { parseCommand, commandHelp, stringOption, numberOption, flagOption } from "./grammar.js";
import SqliteDatabase from "../sqlite.js";
import { getParserForFile } from "../parsers/index.js";
import { getParserCapability, PARSER_CAPABILITIES } from "../parsers/capabilities.js";
import { ConversationSourceReader } from "../conversations/source-reader.js";
import {
  filterBlocks,
  makeEnvelope,
  metadataForBlock,
  normalizeParsedBlock,
  parseBound,
  parseCsv,
  type BlockFilterOptions,
  type ConversationLike,
  type InspectableBlock,
} from "../conversation-block-filters.js";

interface CliArgs {
  positional: string[];
  role?: string;
  type?: string;
  tool?: string;
  toolKind?: string;
  since?: string;
  until?: string;
  content?: string;
  limit: number;
  json: boolean;
}

function usage(): void { console.error(commandHelp(["conversation-blocks"])); }

function parseArgs(argv: string[], mode: string): CliArgs {
  const parsed = parseCommand(["conversation-blocks", mode], argv);
  return { positional: parsed.positionals.length ? parsed.positionals : [stringOption(parsed, "provider")!].filter(Boolean),
    role: stringOption(parsed, "role"), type: stringOption(parsed, "type"), tool: stringOption(parsed, "tool"),
    toolKind: stringOption(parsed, "tool-kind"), since: stringOption(parsed, "since"), until: stringOption(parsed, "until"),
    content: stringOption(parsed, "content", "contains"), limit: numberOption(parsed, "limit") ?? 50, json: flagOption(parsed, "json") };
}

function filterOptions(args: CliArgs): BlockFilterOptions {
  return {
    roles: parseCsv(args.role),
    types: parseCsv(args.type),
    tool: args.tool ?? null,
    toolKind: args.toolKind ?? null,
    since: parseBound(args.since),
    until: parseBound(args.until),
    content: args.content ?? null,
    limit: args.limit,
  };
}

function printHuman(blocks: InspectableBlock[]): void {
  for (const block of blocks) {
    const metadata = metadataForBlock(block);
    const tool = metadata.tool_name ? `\t${metadata.tool_name}` : "\t-";
    const text = block.content.replace(/\s+/g, " ");
    const clipped = text.length > 220 ? `${text.slice(0, 217)}...` : text;
    console.log(`${block.position}\t${block.timestamp ?? "-"}\t${block.type}\t${block.role}${tool}\t${clipped}`);
  }
}

async function runLogs(args: CliArgs): Promise<void> {
  const sourcePath = args.positional[0];
  if (!sourcePath) throw new Error("missing source log path");
  const parser = getParserForFile(sourcePath);
  if (!parser) throw new Error(`no parser registered for ${sourcePath}`);
  const parsed = await parser.parse(sourcePath);
  if (!parsed) {
    if (args.json) {
      console.log(JSON.stringify(makeEnvelope("log", parser.source, {}, filterOptions(args), [], getParserCapability(parser.source)), null, 2));
    }
    return;
  }
  const conversation: ConversationLike = parsed.conversation;
  const blocks = parsed.blocks.map((block) => normalizeParsedBlock(block, conversation));
  const filters = filterOptions(args);
  const filtered = filterBlocks(blocks, filters);
  if (args.json) {
    console.log(JSON.stringify(makeEnvelope("log", parser.source, conversation, filters, filtered, getParserCapability(parser.source)), null, 2));
  } else {
    printHuman(filtered);
  }
}

async function runConversations(args: CliArgs): Promise<void> {
  const dbPath = args.positional[0];
  const ident = args.positional[1];
  if (!dbPath || !ident) throw new Error("missing database path or conversation id");
  const db = new SqliteDatabase(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
  try {
    const conversations = db.prepare(`
      SELECT * FROM conversations
      WHERE id = ? OR session_id = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id
    `).all(ident, ident, ident) as ConversationLike[];
    const exact = conversations.find((row) => row.id === ident);
    if (!exact && conversations.length > 1) throw new Error(`ambiguous conversation reference: ${ident}`);
    const conversation = exact ?? conversations[0];
    if (!conversation?.id) throw new Error(`conversation not found: ${ident}`);
    const read = await new ConversationSourceReader(db).readAll(conversation.id);
    if (read.status !== "source" && read.status !== "legacy") {
      throw new Error(`conversation source ${read.status}: ${read.reason}`);
    }
    const blocks = read.value;
    const filters = filterOptions(args);
    const filtered = filterBlocks(blocks, filters);
    if (args.json) {
      const provider = typeof conversation.source === "string" ? conversation.source : null;
      console.log(JSON.stringify(makeEnvelope("database", provider, conversation, filters, filtered, provider ? getParserCapability(provider as never) : null), null, 2));
    } else {
      printHuman(filtered);
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const args = parseArgs(process.argv.slice(3), mode);
  if (mode === "logs") {
    await runLogs(args);
  } else if (mode === "conversations") {
    await runConversations(args);
  } else if (mode === "capabilities") {
    const provider = args.positional[0];
    const capabilities = provider
      ? PARSER_CAPABILITIES.filter((capability) => capability.source === provider)
      : PARSER_CAPABILITIES;
    if (args.json) {
      console.log(JSON.stringify(capabilities, null, 2));
    } else {
      for (const capability of capabilities) {
        console.log(`${capability.source}\troles=${capability.roles.join(",")}\ttypes=${capability.block_types.join(",")}\ttool_name=${capability.tool_metadata.tool_name}`);
      }
    }
  } else {
    usage();
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
});

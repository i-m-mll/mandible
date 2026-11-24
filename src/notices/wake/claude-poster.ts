/**
 * Posts lines to a Claude Code inbox socket and exits at once.
 *
 * Usage: claude-poster <socket>; the lines to post arrive on stdin. Exit 0 when
 * they were written, `REFUSED_EXIT` when the socket is missing or refuses the
 * connection, 1 otherwise; on failure stderr carries the error.
 *
 * Claude Code consults the auth token only after the posting process has
 * exited, so this process holds nothing open once the lines are written.
 */
import net from "node:net";
import { REFUSED_EXIT } from "./claude.js";

const REFUSED = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function post(socket: string, lines: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    connection.once("error", reject);
    connection.once("connect", () => connection.end(lines, () => resolve()));
  });
}

const socket = process.argv[2];
if (!socket) {
  process.stderr.write("usage: claude-poster <socket>\n");
  process.exit(1);
}
const lines = await stdin();
try {
  await post(socket, lines);
  process.exit(0);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code ?? "";
  process.stderr.write(`${code} ${(error as Error).message}\n`);
  process.exit(REFUSED.has(code) ? REFUSED_EXIT : 1);
}

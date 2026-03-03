import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

import { html as diffHtml, parse as diffParse } from "diff2html";
import { marked } from "marked";

const execFileAsync = promisify(execFile);

export type DiffFile = {
  path: string;
  additions: number;
  deletions: number;
  hunks: unknown[];
};

export type DiffResult = {
  raw: string;
  stat: string;
  files: DiffFile[];
  html: string;
};

export type SpecResult = {
  source: string;
  raw: string;
  html: string;
};

export type CommitLogEntry = {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
  co_authors: string[];
};

export type CommitLogResult = {
  commits: CommitLogEntry[];
  total: number;
};

const CO_AUTHOR_PATTERN = /^Co-Authored-By:\s*(.+?)(?:\s*<.+>)?$/i;

const normalizePath = (value: string): string => value.replace(/^a\//, "").replace(/^b\//, "");

const runGit = async (repoPath: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
};

const readFileIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const readGitFile = async (repoPath: string, ref: string, fileName: string): Promise<string | null> => {
  try {
    const output = await runGit(repoPath, ["show", `${ref}:${fileName}`]);
    return output;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (typeof err.message === "string" && err.message.includes("Path")) {
      return null;
    }
    return null;
  }
};

const readGitNotes = async (repoPath: string, ref: string): Promise<string | null> => {
  try {
    const output = await runGit(repoPath, ["notes", "show", ref]);
    return output;
  } catch (error) {
    return null;
  }
};

const extractCoAuthors = (body: string): string[] => {
  const authors = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(CO_AUTHOR_PATTERN);
    if (!match) {
      continue;
    }
    const name = match[1].trim();
    if (name.length > 0) {
      authors.add(name);
    }
  }
  return Array.from(authors);
};

const mapDiffFiles = (diffFiles: Array<Record<string, unknown>>): DiffFile[] =>
  diffFiles.map((file) => {
    const newName = typeof file.newName === "string" ? file.newName : "";
    const oldName = typeof file.oldName === "string" ? file.oldName : "";
    const filePath = normalizePath(newName || oldName);
    const additions = typeof file.addedLines === "number" ? file.addedLines : 0;
    const deletions = typeof file.deletedLines === "number" ? file.deletedLines : 0;
    const blocks = Array.isArray(file.blocks) ? file.blocks : [];
    return {
      path: filePath,
      additions,
      deletions,
      hunks: blocks,
    };
  });

export const getDiff = async (repoPath: string, base: string, head: string): Promise<DiffResult> => {
  const diffArgs = ["diff", `${base}...${head}`];
  const statArgs = ["diff", "--stat", `${base}...${head}`];

  const [raw, stat] = await Promise.all([
    runGit(repoPath, diffArgs),
    runGit(repoPath, statArgs),
  ]);

  const jsonFiles = diffParse(raw, {
    diffStyle: "word",
    matching: "lines",
  }) as unknown as Array<Record<string, unknown>>;

  const html = diffHtml(raw, {
    outputFormat: "line-by-line",
    drawFileList: true,
    matching: "lines",
  });

  return {
    raw,
    stat: stat.trim(),
    files: mapDiffFiles(jsonFiles),
    html,
  };
};

export const getSpec = async (repoPath: string, branch: string): Promise<SpecResult> => {
  if (branch) {
    const noteContent = await readGitNotes(repoPath, branch);
    if (noteContent !== null) {
      return {
        source: "git-notes",
        raw: noteContent,
        html: marked.parse(noteContent) as string,
      };
    }
  }

  const candidates = ["COMMIT_MSG.txt", "README_COMMIT.md"];

  for (const candidate of candidates) {
    const filePath = path.join(repoPath, candidate);
    const content = await readFileIfExists(filePath);
    if (content !== null) {
      return {
        source: candidate,
        raw: content,
        html: marked.parse(content) as string,
      };
    }

    if (branch) {
      const gitContent = await readGitFile(repoPath, branch, candidate);
      if (gitContent !== null) {
        return {
          source: candidate,
          raw: gitContent,
          html: marked.parse(gitContent) as string,
        };
      }
    }
  }

  return {
    source: "",
    raw: "",
    html: "",
  };
};

export const getCommitLog = async (
  repoPath: string,
  base: string,
  head: string,
): Promise<CommitLogResult> => {
  const format = [
    "%H",
    "%h",
    "%an",
    "%ad",
    "%s",
    "%B",
  ].join("%x1f");
  const logArgs = [
    "log",
    "--date=iso-strict",
    `--pretty=format:${format}%x1e`,
    `${base}...${head}`,
  ];

  const output = await runGit(repoPath, logArgs);
  const records = output.split("\x1e").filter((entry) => entry.trim().length > 0);

  const commits: CommitLogEntry[] = records.map((record) => {
    const [hash, shortHash, author, date, subject, body] = record.split("\x1f");
    const fullBody = body ?? "";
    return {
      hash: hash ?? "",
      short_hash: shortHash ?? "",
      message: subject ?? "",
      author: author ?? "",
      date: date ?? "",
      co_authors: extractCoAuthors(fullBody),
    };
  });

  return {
    commits,
    total: commits.length,
  };
};

import type { WorkScanner } from "./work-scanner.js";
import type {
  GitBugIssueDetail,
  IssueRepoSummary,
} from "./types.js";

/**
 * Legacy scanner facade retained for compatibility while issue reads are
 * served from the Mandible ledger. This facade remains for callers that still
 * need the established scanner-shaped read interface.
 */
export class IssueScanner {
  public readonly workScanner: WorkScanner;

  constructor(workScanner: WorkScanner) {
    this.workScanner = workScanner;
  }

  getRepoSummaries(): IssueRepoSummary[] {
    return [];
  }

  getIssueDetail(_repoId: string, _issueId: string): GitBugIssueDetail | null {
    return null;
  }

  getIssueStatus(_repoId: string, _issueId: string): "open" | "closed" | null {
    return null;
  }

  findIssueAcrossRepos(_issueId: string): GitBugIssueDetail | null {
    return null;
  }

  scanAll(): IssueRepoSummary[] {
    return [];
  }

  async scanAllAsync(): Promise<IssueRepoSummary[]> {
    return [];
  }

  scanRepoById(_repoId: string): boolean {
    return false;
  }

  async scanRepoByIdAsync(_repoId: string): Promise<boolean> {
    return false;
  }

  closeIssue(_repoId: string, _issueId: string): boolean {
    return false;
  }

  reopenIssue(_repoId: string, _issueId: string): boolean {
    return false;
  }

  addComment(_repoId: string, _issueId: string, _message: string): boolean {
    return false;
  }

  addLabel(_repoId: string, _issueId: string, _label: string): boolean {
    return false;
  }

  removeLabel(_repoId: string, _issueId: string, _label: string): boolean {
    return false;
  }
}

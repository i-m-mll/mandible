// Retroactive credential redaction (issue b3e4a09).
//
// Ingest-time masking (see credential-leak-scan.ts) keeps new transcripts clean,
// but a credential that leaked before that existed is already sitting in the
// normalized index and in the provider's source JSONL. This module is the
// response tool: given a credential id, it re-verifies stored text against that
// credential's fingerprint and masks every occurrence.
//
// Two invariants govern everything here:
//
//   1. The plaintext is never printed, logged, returned, or written anywhere.
//      A candidate is verified by peppered HMAC against the stored fingerprint
//      and then immediately replaced; only counts and ids leave this module.
//   2. Blocks are reproducible from their source files, so a DB-only redaction
//      is undone by the next full re-ingest of an unpatched file. `--patch-
//      sources` is the durable half: it rewrites the same verified spans in the
//      local transcript, leaving every other byte untouched.
//
// Unlike detection, redaction deliberately matches revoked credentials too: the
// recommended operator sequence is rotate (which revokes) and then redact, so
// refusing to redact a revoked credential would make the tool useless exactly
// when it is needed.

import fs from "node:fs";
import path from "node:path";

import {
  credentialMaskFor,
  credentialScanPepper,
  extractTokenCandidatesWithStatus,
  maskUnverifiedCandidates,
  remapCredentialLeakAlertBlockIds,
  replaceAllCounted,
} from "./credential-leak-scan.js";
import { API_TOKEN_PREFIX, fingerprintForToken } from "./client-auth/tokens.js";
import { compressContent, decompressContent } from "./compression.js";
import { assignConversationBlockIds, conversationBlockId } from "./conversation-block-id.js";
import { getDaemonLogger } from "./daemon-log.js";
import type { Db } from "./db.js";
import { UserRegistryError } from "./users/store.js";
import { resolveId } from "./entity-refs.js";

const redactionLog = getDaemonLogger();

const DEFAULT_BATCH_SIZE = 500;
const SOURCE_DISCOVERY_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_PATCH_BYTES = 256 * 1024 * 1024;
const SOURCE_DISCOVERY_OVERLAP = API_TOKEN_PREFIX.length + 43 - 1;

/**
 * How many times a source rewrite may restart because the file changed under
 * it. Transcripts are appended to by a live agent, so one lost race is normal
 * and a second is worth retrying; a file that keeps moving is refused rather
 * than rewritten from a stale snapshot.
 */
const MAX_PATCH_ATTEMPTS = 3;

/**
 * LIKE pattern for the minted-token prefix. `_` is a single-character wildcard
 * in LIKE, which only widens the match here — every real candidate is still
 * hash-verified afterwards, so a wildcard match is never mistaken for a hit.
 */
const TOKEN_PREFIX_PATTERN = API_TOKEN_PREFIX;

export interface CredentialRedactionOptions {
  /** Also rewrite the verified spans in the local source transcripts. */
  patchSources?: boolean;
  /** Rows fetched per batch. */
  batchSize?: number;
  pepper?: string;
}

export interface CredentialRedactionSourceReport {
  /** Distinct source files reachable from the affected conversations. */
  candidate_files: number;
  patched_files: number;
  /** Files that held no verified occurrence (already clean). */
  unchanged_files: number;
  /** Files the conversation still points at but that are no longer on disk. */
  missing_files: number;
  /** Files that could not be rewritten (permissions, IO). */
  failed_files: number;
  /**
   * Files that were published and then had a write fail whose rollback also
   * failed, so their bytes are neither the original nor a clean patch. Never
   * counted as patched: the state is unknown, and an operator has to look at
   * the file. Their spans are not counted either, for the same reason.
   *
   * Their recovered/abandoned byte counts are still reported. Those are
   * measured against the unlinked inode and against appends whose fsync
   * returned, so they stay true statements; what is unknown is only what the
   * file holds past the last committed append.
   */
  indeterminate_files: number;
  /**
   * Files deliberately left alone: the file kept changing under the rewrite, or
   * its scan hit the verification budget so a rewrite could not be complete.
   * Refusing is the safe outcome — a source rewrite is destructive.
   */
  refused_files: number;
  patched_spans: number;
  /**
   * Bytes a writer appended to the old inode during or after the rename and
   * that were copied onto the patched file rather than lost with it.
   */
  recovered_tail_bytes: number;
  /**
   * Bytes still sitting in the unlinked inode when bounded tail recovery gave
   * up. Non-zero means a writer is appending faster than recovery drains it and
   * those events exist only in that writer's descriptor.
   *
   * Sums only the files whose tail could actually be measured — see
   * `unknown_tail_files`. Zero here therefore means "nothing was left behind on
   * any file this count covers", never "nothing could be determined".
   */
  abandoned_tail_bytes: number;
  /**
   * Files whose abandoned tail could not be measured at all, because the size
   * of the inode the rename unlinked could not be read. Unknown, not zero: this
   * is exactly the state in which a writer's bytes go with the closing inode,
   * so folding it into `abandoned_tail_bytes: 0` would report the loss as a
   * clean run (issue b3e4a09, sixth-pass item 2).
   */
  unknown_tail_files: number;
  /**
   * Files whose patched bytes are in place but whose original permission bits
   * could not be restored, so they are left owner-writable. Reported rather
   * than swallowed: a mode the operator did not choose is a security-relevant
   * outcome of a security command.
   */
  mode_restore_failed_files: number;
}

export interface CredentialRedactionReport {
  credential_id: string;
  credential_status: string;
  scanned_blocks: number;
  redacted_blocks: number;
  /** Derived conversation fields (title, summary) rewritten. */
  redacted_metadata_fields: number;
  /** Total occurrences replaced in the index, across blocks and metadata. */
  redacted_spans: number;
  /**
   * Spans masked without verification because a text exhausted the candidate
   * budget. Fail-closed cleanup, not a match for this credential.
   */
  unverified_spans: number;
  redacted_conversations: number;
  /** Blocks whose id was recomputed from the masked content (see below). */
  renumbered_blocks: number;
  /**
   * Blocks whose recomputed id was already taken. The affected conversation's
   * ids are then re-derived as a whole, the way the next full ingest derives
   * them, so a conflict is a resolved event rather than a kept-stale id.
   */
  id_conflicts: number;
  /**
   * Blocks a conflict left on an id no ingest can re-derive, because the
   * conversation-wide re-derivation could not be applied. Non-zero means the
   * index and a future re-ingest will disagree about those ids.
   */
  unresolved_id_conflicts: number;
  /** Leak alerts repointed from a renumbered block id to its new id. */
  remapped_leak_alerts: number;
  truncated: boolean;
  sources: CredentialRedactionSourceReport | null;
}

interface CredentialRow {
  id: string;
  type: string;
  status: string;
  fingerprint: string;
}

/**
 * Resolve a credential by exact id or by an unambiguous id prefix.
 *
 * Ids are 26-character ULIDs; operators copy them out of alert text, so a
 * prefix is the ergonomic form. Ambiguity is an error rather than a guess —
 * redaction is a bulk rewrite and must never run against the wrong credential.
 */
export function resolveCredentialForRedaction(db: Db, ref: string): CredentialRow {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new UserRegistryError("invalid", "A credential id is required.");
  }
  const resolved = resolveId(db, "credential", trimmed);
  if (!resolved.ok) {
    throw resolved.error === "ambiguous"
      ? new UserRegistryError("invalid", `Credential id '${trimmed}' is ambiguous (${resolved.matches.join(", ")}). Use a longer prefix.`)
      : new UserRegistryError("not_found", `No credential '${trimmed}'.`);
  }
  const credential = db
    .prepare("SELECT id, type, status, fingerprint FROM user_credentials WHERE id = ?")
    .get(resolved.id) as CredentialRow;
  if (credential.type !== "api_token") {
    throw new UserRegistryError(
      "invalid",
      `Credential '${credential.id}' is a ${credential.type}, not an api_token. `
        + "Only bearer-token plaintext is detectable in transcript text.",
    );
  }
  return credential;
}

interface MaskedCredentialText {
  text: string;
  replacements: number;
  /** Spans masked without verification after the candidate budget ran out. */
  unverified: number;
  truncated: boolean;
}

/**
 * Mask every verified occurrence of one credential inside a text.
 *
 * Verification is by fingerprint equality, so this matches the same bytes the
 * client-auth path would accept as that credential and nothing else — a
 * lookalike `mandible_pat_…` string is left alone.
 *
 * `conservative` decides what happens when a text carries more distinct
 * token-shaped spans than the candidate budget allows checking. In the index
 * that is fail-closed masking: the remaining spans were never verified, so they
 * are replaced rather than left in a row this command has just promised to
 * clean. For a source file it is the opposite — an incomplete scan must not
 * license a destructive partial rewrite — so the caller passes `false` and
 * refuses the file instead.
 */
function maskCredentialInText(
  text: string,
  pepper: string,
  fingerprint: string,
  mask: string,
  options: { conservative?: boolean } = {},
): MaskedCredentialText {
  const extracted = extractTokenCandidatesWithStatus(text);
  const checked = new Set<string>();
  let next = text;
  let replacements = 0;
  for (const candidate of extracted.candidates) {
    checked.add(candidate);
    if (fingerprintForToken(pepper, candidate) !== fingerprint) continue;
    const replaced = replaceAllCounted(next, candidate, mask);
    next = replaced.text;
    replacements += replaced.replacements;
  }
  if (!extracted.truncated || options.conservative !== true) {
    return { text: next, replacements, unverified: 0, truncated: extracted.truncated };
  }
  const masked = maskUnverifiedCandidates(next, (candidate) => checked.has(candidate));
  return {
    text: masked.text,
    replacements,
    unverified: masked.replacements,
    truncated: true,
  };
}

/**
 * `indeterminate` is deliberately not a flavour of `failed`. A failed file was
 * not rewritten at all — the operator can re-run and nothing is at stake. An
 * indeterminate one was published and then had a write fail in a way that could
 * not be rolled back, so its bytes may be neither the original nor a clean
 * patch. That needs a person to look at the file, which is a different
 * instruction and therefore a different bucket.
 */
type PatchStatus =
  | "patched"
  | "unchanged"
  | "missing"
  | "failed"
  | "refused"
  | "indeterminate";

interface PatchOutcome {
  status: PatchStatus;
  replacements: number;
  /** Bytes appended to the old inode after the rename and carried over. */
  recoveredBytes: number;
  /**
   * Bytes still in the unlinked inode when tail recovery gave up, or `null`
   * when the inode's size could not be determined at all.
   */
  abandonedBytes: number | null;
  /** The patch landed but the original mode could not be put back. */
  modeRestoreFailed: boolean;
}

function patchOutcome(status: PatchStatus, replacements = 0): PatchOutcome {
  return {
    status,
    replacements,
    recoveredBytes: 0,
    abandonedBytes: 0,
    modeRestoreFailed: false,
  };
}

/**
 * How many times tail recovery re-checks the old inode after the rename.
 *
 * A writer that appended once during the rename window is very likely to append
 * again while the recovery append is running, so one pass is not enough; a
 * writer that never stops is not something a bounded loop can win against, and
 * each round is reported.
 */
const MAX_TAIL_RECOVERY_ROUNDS = 8;

/** Read `length` bytes from `fd` starting at `offset`, or null if short. */
function readExactly(fd: number, offset: number, length: number): Buffer | null {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const chunk = fs.readSync(fd, buffer, read, length - read, offset + read);
    if (chunk <= 0) break;
    read += chunk;
  }
  return read === length ? buffer : null;
}

/**
 * Does `filePath` still resolve to the inode behind `fd`, with exactly the
 * snapshot bytes the replacement was built from?
 *
 * `fd` was opened before the snapshot was taken and is still open, so the inode
 * being inspected cannot have been swapped underneath the check. Comparing the
 * held descriptor's `ino`/`dev` against a fresh path stat is what proves the
 * *path* still points at that same inode — a file replaced at the same path
 * fails here. Content equality is the authority for "unchanged"; mtime is not
 * consulted, because a same-bytes touch is not a reason to refuse.
 */
function sourceUnchanged(fd: number, filePath: string, snapshot: Buffer): boolean {
  try {
    const held = fs.fstatSync(fd);
    const atPath = fs.statSync(filePath);
    if (held.ino !== atPath.ino || held.dev !== atPath.dev) return false;
    if (held.size !== snapshot.length) return false;
    const buffer = readExactly(fd, 0, snapshot.length);
    return buffer !== null && buffer.equals(snapshot);
  } catch {
    return false;
  }
}

/** Write every byte of `buffer` to `fd`, or throw. */
function writeAll(fd: number, buffer: Buffer): void {
  let written = 0;
  while (written < buffer.length) {
    const chunk = fs.writeSync(fd, buffer, written, buffer.length - written);
    // A zero-length write is not progress; treating it as one would spin
    // forever, and treating a short write as complete is how the old code lost
    // the remainder of a tail while reporting it recovered.
    if (chunk <= 0) throw new Error("short write");
    written += chunk;
  }
}

/**
 * What one checkpointed append left behind.
 *
 * These four states are materially different instructions to the caller, and
 * collapsing them into a boolean is what the fifth-pass primitive got wrong
 * (issue b3e4a09, sixth-pass item 1):
 *
 *   - `committed`   the payload is whole and durable, and any rewind it made
 *                   is permanent. Offsets may advance.
 *   - `unchanged`   nothing was attempted. The checkpoint could not be taken,
 *                   so the file is exactly as the previous operation left it —
 *                   including, for a splice, the region the payload was going
 *                   to replace. There is nothing to restore, and restoring
 *                   anyway duplicates that region.
 *   - `rewound`     the write failed and the file was put back at the
 *                   checkpoint. For a splice that means the replaced region is
 *                   gone, so restoring it is exactly the right move.
 *   - `indeterminate` the write failed and the rollback failed with it. What
 *                   the file holds is unknown: possibly a fragment of the
 *                   payload, possibly not. Nothing may be written on top of it
 *                   and nothing may call it patched.
 */
type AppendOutcome = "committed" | "unchanged" | "rewound" | "indeterminate";

/**
 * Append `payload` to the published replacement so that it either lands whole
 * and durably or leaves the file byte-for-byte as it was — and say which.
 *
 * This is the single primitive every write to the replacement goes through
 * after the rename: the ordinary tail appends, the seam splice that rewrites
 * the snapshot's open final line, and the restoration that puts that line back
 * when a splice fails (issue b3e4a09, fifth-pass item 1). Rollback used to be
 * split between the append and a bespoke failure handler that re-wrote the seam
 * inside a swallowing catch — so a restoration that itself wrote half and threw
 * published a truncated line, and the file was still reported patched. One
 * primitive leaves exactly one failure shape to reason about: the file is at
 * the checkpoint, and the caller is told the bytes did not land.
 *
 * `rewindBy` is how many bytes at the end of the file the payload replaces:
 * zero for a plain append, the seam's written length for a splice. The
 * checkpoint is that rewind point, so a failed splice and a failed restoration
 * both leave the file at the same offset with no fragment in between. The
 * descriptor is in append mode, so a write after a rewind continues from the
 * new end rather than from a stale file position.
 *
 * `committed` is returned only after fsync has returned. Nothing may treat
 * bytes as committed before they are durable — advancing the offset first is
 * how the old seam handler under-reported abandoned bytes when the restoration
 * fsync failed.
 */
function checkpointedAppend(outFd: number, payload: Buffer, rewindBy = 0): AppendOutcome {
  let checkpoint: number;
  try {
    checkpoint = fs.fstatSync(outFd).size;
  } catch {
    // No checkpoint means no rewind and no write: every byte of the file is
    // still what it was one instruction ago. This is the state that must not be
    // confused with a rewind — a splice that never took its checkpoint never
    // removed the region it was going to replace.
    return "unchanged";
  }
  const base = Math.max(0, checkpoint - rewindBy);
  if (base !== checkpoint) {
    try {
      fs.ftruncateSync(outFd, base);
    } catch {
      // The rewind is the first thing that would have changed the file, and it
      // did not happen, so this is the same "nothing was attempted" state.
      return "unchanged";
    }
  }
  try {
    writeAll(outFd, payload);
    fs.fsyncSync(outFd);
    return "committed";
  } catch {
    try {
      fs.ftruncateSync(outFd, base);
    } catch {
      // The rollback itself failed, so the file may still hold a fragment of
      // the payload. Nothing here can undo that on a disk that is failing both
      // writes and truncates, and nothing may be appended on top of a fragment
      // whose extent is unknown.
      return "indeterminate";
    }
    try {
      fs.fsyncSync(outFd);
    } catch {
      // The truncate is in effect for every reader of this file; only its
      // durability across a crash is unproven. Not knowing whether a rewind
      // survives a power cut is not the same as not knowing what the file
      // holds, so this stays `rewound`.
    }
    return "rewound";
  }
}

/**
 * The snapshot's open final line, when it has one.
 *
 * `source` is the unmasked bytes after the snapshot's last newline, i.e. the
 * region the writer's next bytes continue. `written` is exactly the bytes that
 * same region occupies in the replacement — the masked form, which is what has
 * to go back verbatim if the splice that rewrites it fails.
 */
interface SeamRegion {
  source: string;
  written: Buffer;
}

/**
 * Recovery accounting, owned by the caller so that it survives an exception.
 *
 * `committed` is the old-inode offset of the first byte not yet durably on the
 * replacement; `replacements` counts verified spans masked in recovered bytes.
 * They live here rather than as locals inside the recovery loop because a
 * failure that loop does not model — a read error on the unlinked inode is the
 * realistic one — must still settle into a report instead of going up the stack
 * with the numbers (issue b3e4a09, fifth-pass item 2).
 */
interface TailProgress {
  committed: number;
  replacements: number;
  /**
   * An append reported `indeterminate`: the replacement holds something this
   * code cannot describe. It lives on the caller-owned record for the same
   * reason the offsets do — a later exception must not lose the fact — and it
   * is what forbids the file's outcome from ever being `patched`.
   */
  indeterminate: boolean;
}

/**
 * Turn recovery progress into the report's recovered/abandoned pair.
 *
 * `abandoned` is `null` when the old inode's size could not be determined. That
 * is not the same number as zero and must not be reported as one (issue
 * b3e4a09, sixth-pass item 2): the size is measured through the descriptor on
 * the inode the rename unlinked, so a persistent IO error there is exactly the
 * case where a writer's bytes are about to be lost with that inode — and the
 * old catch turned it into `abandoned: 0`, an operator-visible "nothing was
 * left behind" over bytes nothing could see again.
 */
function settleTail(
  fd: number,
  fromOffset: number,
  progress: TailProgress,
): { bytes: number; replacements: number; abandoned: number | null } {
  let abandoned: number | null;
  try {
    abandoned = Math.max(0, fs.fstatSync(fd).size - progress.committed);
  } catch {
    abandoned = null;
  }
  return {
    bytes: Math.max(0, progress.committed - fromOffset),
    replacements: progress.replacements,
    abandoned,
  };
}

interface TailRecoveryInput {
  /** Read-only descriptor on the inode the rename unlinked. */
  fd: number;
  /** The replacement's own descriptor, held since it was created. */
  outFd: number;
  /** Old-inode offset the snapshot ended at. */
  fromOffset: number;
  /** The snapshot's open final line, or null when it ended on a boundary. */
  seam: SeamRegion | null;
  pepper: string;
  fingerprint: string;
  mask: string;
}

/**
 * Why the post-rename tail is spliced rather than refused.
 *
 * The simpler shape — notice after the rename that the old inode grew, declare
 * an active writer, refuse the file, and tell the operator to re-run when idle
 * — was evaluated and rejected, because at that point refusal is not deferral.
 * The rename unlinked the old inode: it has no path any more. Its tail is
 * reachable only through the descriptor this code is holding, and when that
 * descriptor closes the bytes are gone for good. A later re-run reads the
 * patched file, which never contained them. So "refuse and re-run" converges on
 * a transcript that is permanently missing every event the writer produced
 * during the window — the opposite of this command's stated contract that every
 * byte outside a verified span survives.
 *
 * Putting the file back is worse still. There is no path to rename the old
 * inode to, so restoring means writing the snapshot to the path again — and the
 * snapshot is the version containing the live credential. A redaction tool
 * cannot answer a race by rewriting the secret it was asked to remove.
 *
 * Refusal before the rename is a different question and is already the policy:
 * a file that changed between the snapshot and the pre-rename re-verification
 * restarts the cycle, and after MAX_PATCH_ATTEMPTS it is refused untouched.
 * That is where "the writer is hot, come back later" belongs, because there the
 * original is still intact at its path. Everything below deals only with the
 * residue that no pre-rename check can cover.
 */

/**
 * Carry bytes appended to the old inode after the rename onto the new file.
 *
 * `fd` still refers to the inode the rename unlinked. A transcript writer that
 * held that file open when the rename happened keeps appending to it, and those
 * bytes are unreachable through the path — they exist only behind this
 * descriptor. Reading them here and appending them to the patched file is what
 * turns the post-rename window from silent data loss into a copy.
 *
 * Recovered bytes are masked before they are appended: they were never scanned,
 * and appending them verbatim would put the plaintext straight back into the
 * file the redaction just cleaned. Masking is fail-closed, so a recovered tail
 * that exhausts the candidate budget has its unchecked spans masked rather than
 * written through — the opposite of the whole-file rule, because refusing here
 * means discarding bytes that exist nowhere else.
 *
 * Appends stop at a line boundary and the partial remainder is carried into the
 * next round, so a token split across two reads is never half-masked. JSONL
 * records cannot contain a raw newline, so a line boundary is a safe cut.
 *
 * The same cut argument extends backwards across the splice (issue b3e4a09,
 * third-pass finding 2). A snapshot that does not end in a newline ends mid
 * record, and the writer's next bytes continue *that* record: a token can be
 * split with its first characters in the snapshot and the rest in the tail, and
 * scanning the two halves separately matches neither, so a direct join
 * reassembles working plaintext. Recovery therefore treats the snapshot's open
 * final line as part of the first recovered chunk — it truncates that region
 * back off the replacement and rewrites the joined region as one masked text.
 *
 * The join itself stays byte-faithful: nothing is inserted at the seam. That is
 * not a convenience, it is what the old inode actually holds. The writer's
 * descriptor was positioned at end-of-file, so its bytes land immediately after
 * the snapshot's last byte with no separator; the concatenation this function
 * writes is exactly the byte sequence a reader of the unlinked inode would see.
 * Inserting a newline to "terminate" the open record would fabricate a record
 * boundary that never existed and split one JSON object into two invalid ones.
 *
 * Offsets advance only after an append is proven complete. `progress.committed`
 * is the old-inode offset of the first byte not yet durably on the replacement,
 * so a failed write, a short write, or a failed fsync leaves those bytes counted
 * as abandoned instead of vanishing behind a zero report.
 *
 * Every write goes through `checkpointedAppend` (issue b3e4a09, fourth-pass
 * items 2 and 3, completed in the fifth pass). That includes the two halves of
 * the seam: the splice that replaces the masked open final line with the joined
 * masked region, and — when the splice fails — the restoration that puts that
 * line back. Both are the same operation against the same checkpoint, so there
 * is no failure path left that can publish a fragment. Previously `writeAll`
 * could put half a masked chunk on disk and then throw, leaving a truncated
 * record in the file while the report called the whole chunk abandoned; the
 * seam handler then re-appended the open final line *on top of* that fragment,
 * and if that second write also failed part-way its exception was swallowed and
 * the truncated line was published as a patched file. Now a restoration that
 * cannot land leaves the replacement at the rewind point — the open final line
 * absent rather than mangled — and `committed` drops below it so those bytes
 * are reported abandoned. They are still in the unlinked inode the abandoned
 * count is measured against, so that report is literally true.
 *
 * What the primitive *reports* is the sixth-pass correction. A boolean cannot
 * distinguish "the splice never started" from "the splice was rolled back", and
 * the restoration is only correct in the second case: an append that could not
 * take its checkpoint left the open final line exactly where it was, so writing
 * it back duplicates it. Nor can a boolean distinguish either of those from
 * "the rollback failed too", where the file holds an unknown fragment and the
 * only safe move is to stop writing and refuse to call the file patched. The
 * three failure states are now distinct values and the caller branches on them
 * (issue b3e4a09, sixth-pass item 1).
 */
function recoverAppendedTail(input: TailRecoveryInput, progress: TailProgress): void {
  const { fd, outFd, fromOffset, seam, pepper, fingerprint, mask } = input;
  // Recovery starts fully accounted: the whole snapshot is on the replacement
  // to begin with, including the open final line — masked, but present — so
  // `progress.committed` enters at `fromOffset`.
  let readCursor = fromOffset;
  // `carried` is the contiguous region starting at `progress.committed` that
  // has not been appended yet. It is seeded with the snapshot's open final line
  // so the seam is masked as one text with the writer's continuation of it.
  let carried = seam?.source ?? "";
  let seamPending = seam !== null;
  let failed = false;

  const appendMasked = (chunk: string): boolean => {
    if (chunk.length === 0) return true;
    const masked = maskCredentialInText(chunk, pepper, fingerprint, mask, {
      conservative: true,
    });
    const payload = Buffer.from(masked.text, "latin1");
    // The seam rewrites the snapshot's open final line as the head of this
    // chunk, so that line comes off the replacement as part of the same
    // checkpointed write that replaces it.
    const splice = seamPending ? seam : null;
    const result = checkpointedAppend(
      outFd,
      payload,
      splice === null ? 0 : splice.written.length,
    );
    if (result === "committed") {
      if (splice !== null) {
        seamPending = false;
        progress.committed -= splice.source.length;
      }
      progress.replacements += masked.replacements;
      progress.committed += chunk.length;
      return true;
    }
    if (result === "indeterminate") {
      // The replacement holds something nobody can describe. Writing the seam
      // back would append onto a fragment of unknown length, so recovery stops
      // here and the file is reported for inspection instead of patched. The
      // offsets are left where they are: they are claims about a file whose
      // state is now unknown, and adjusting them would dress that up as an
      // account.
      progress.indeterminate = true;
      return false;
    }
    if (splice !== null && result === "rewound") {
      // Only a rewound splice actually removed the open final line, and only
      // then is there anything to put back (issue b3e4a09, sixth-pass item 1).
      // An `unchanged` splice never took its checkpoint, so the line is still
      // on the file — restoring it there would write it a second time and
      // publish a duplicated record.
      //
      // Putting the line back is an append like any other, so it uses the same
      // primitive: it lands whole and durably, or the file stays at the rewind
      // point with no fragment of it. Only when it does not land does
      // `committed` drop below the seam — never before the restoration's own
      // fsync has returned.
      const restored = checkpointedAppend(outFd, splice.written);
      if (restored !== "committed") {
        if (restored === "indeterminate") progress.indeterminate = true;
        progress.committed -= splice.source.length;
      }
      // `seamPending` is deliberately left alone: a failure ends recovery, and
      // whether the seam is back on the replacement is now the restoration's
      // answer rather than a flag anything else consults.
    }
    return false;
  };

  for (let round = 0; round < MAX_TAIL_RECOVERY_ROUNDS; round += 1) {
    let size: number;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      break;
    }
    if (size <= readCursor) break;
    const chunk = readExactly(fd, readCursor, size - readCursor);
    if (chunk === null) break;
    readCursor = size;
    const buffered = carried + chunk.toString("latin1");
    const cut = buffered.lastIndexOf("\n");
    if (cut < 0) {
      carried = buffered;
      continue;
    }
    if (!appendMasked(buffered.slice(0, cut + 1))) {
      failed = true;
      break;
    }
    carried = buffered.slice(cut + 1);
  }

  // Whatever is still buffered is a partial final line. It is flushed rather
  // than dropped: a transcript that ends mid-line is the normal state of a file
  // being written to, while a dropped remainder is bytes gone for good.
  //
  // Not after a failed append, though: `carried` still holds the region that
  // append was carrying, so flushing it here would write those bytes a second
  // time. Once a write to the replacement has failed, recovery is over and the
  // remainder is reported. Nor when nothing was ever read: `carried` is then
  // just the seam, which is already on the replacement, and rewriting it would
  // be a truncate-and-write over a file that needs neither.
  const grew = readCursor > fromOffset;
  if (!failed && grew && carried.length > 0) appendMasked(carried);
}

/**
 * Rewrite one source transcript in place.
 *
 * The file is handled as latin1 so the round trip is byte-exact for any input,
 * including invalid UTF-8 that a lossy utf8 decode would silently rewrite —
 * everything outside the replaced spans must survive untouched. The token
 * charset is ASCII, so matching in latin1 is exact.
 *
 * The write is temp-plus-rename within the same directory, so a reader either
 * sees the whole old file or the whole new one. mtime is deliberately NOT
 * preserved: the next ingest should see the file as changed and re-index the
 * redacted content.
 *
 * Both files are held by descriptor for the whole operation, and every step
 * after each open works on a descriptor rather than on a path (issue b3e4a09,
 * fourth-pass item 1). The replacement in particular is opened exactly once, at
 * creation, and that one descriptor carries it through the write, the rename,
 * every tail append, and the mode restore. The previous shape closed it and
 * reopened the temp path with "a" to get an append descriptor, which is a hole
 * rather than a detail: if the temp path stopped naming that file in between —
 * anything from a stray cleaner to a hostile unlink in a shared directory —
 * "a" *created* an empty file, and the rename published that empty file over
 * the operator's transcript. Nothing in the sequence could notice. Holding the
 * descriptor removes the window instead of checking for it, and it is also why
 * the temp file needs no permission gymnastics: the mode is checked when the
 * descriptor is opened, so a replacement created with a read-only source's mode
 * is still writable through the descriptor this code already holds.
 *
 * Transcripts are appended to while an agent is running, so the snapshot the
 * replacement was built from can be stale by the time it would be renamed into
 * place — which would silently drop every event written in between (issue
 * b3e4a09, review finding 4). Three mechanisms cover that:
 *
 *   1. One read-only descriptor is opened before the snapshot and held until
 *      after the rename. The snapshot is read through it, the pre-rename
 *      re-verification is read through it, and the post-rename tail recovery is
 *      read through it — so every check inspects the same inode rather than
 *      whatever the path happens to name at that instant.
 *   2. A file that changed before the rename restarts the whole
 *      read-mask-write cycle on the newer bytes; after MAX_PATCH_ATTEMPTS it is
 *      refused and reported rather than rewritten from a stale snapshot.
 *   3. A file that grew *during* the rename window, or afterwards through a
 *      descriptor the writer still holds, is reconciled by copying the appended
 *      tail off the unlinked inode onto the patched file (see
 *      recoverAppendedTail). This is what closes the residual the previous
 *      round left open: the window is still not zero, but bytes written into it
 *      are recovered rather than lost.
 *
 * Two limits remain, honestly. Tail recovery is bounded: a writer that keeps
 * appending faster than the recovery loop drains it eventually exhausts
 * MAX_TAIL_RECOVERY_ROUNDS, and the bytes still in the unlinked inode at that
 * point are reported as abandoned rather than silently dropped. And a writer
 * that keeps the old descriptor open indefinitely keeps writing into a file
 * nothing can see; only that writer closing and reopening the path ends it.
 *
 * The in-place alternative — rewriting the verified spans through the
 * descriptor and keeping the inode, which would make concurrent appends a
 * non-issue — was examined and rejected. It only works if the replacement is
 * exactly as long as the plaintext, and it is not: a mask is 32-34 bytes
 * against a 56-byte token, so an in-place rewrite has to shift every following
 * byte and truncate, which is both non-atomic and a race with the very appends
 * it was meant to tolerate. Padding masks to token length to make them
 * length-preserving would work mechanically, but the mask is a cross-path
 * reproducibility contract — ingest-time masking, index redaction, and source
 * patching must all emit the same bytes or block ids diverge — so it would mean
 * padding every mask everywhere, permanently, to buy a rarer race than the one
 * tail recovery already handles.
 */
function patchSourceFile(
  filePath: string,
  pepper: string,
  fingerprint: string,
  mask: string,
): PatchOutcome {
  for (let attempt = 1; attempt <= MAX_PATCH_ATTEMPTS; attempt += 1) {
    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return patchOutcome(code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed");
    }
    try {
      const outcome = patchThroughDescriptor(fd, filePath, pepper, fingerprint, mask, attempt);
      if (outcome !== null) return outcome;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do with a close failure on a read-only descriptor.
      }
    }
  }
  return patchOutcome("refused");
}

/**
 * How far one attempt got with the replacement, as a state rather than a set of
 * booleans (issue b3e4a09, sixth-pass item 1).
 *
 *   unpublished → nothing was renamed into place; the temp file is discarded.
 *   stale       → the source moved under the attempt; re-read and try again.
 *   published   → the replacement is the file at that path, and its contents
 *                 are exactly what this code wrote.
 *   inconsistent→ published, and then an append failed in a way that could not
 *                 be rolled back, so the contents are not known. Terminal.
 *
 * The last one exists so that "do not report an uncertain file as patched" is a
 * property of the machine instead of a check somebody has to remember to write:
 * `inconsistent` has no outgoing transition, and it is the only state that maps
 * to `indeterminate`, exactly as `published` is the only state that maps to
 * `patched`.
 */
type PublicationState = "unpublished" | "stale" | "published" | "inconsistent";

/** Total state → outcome mapping. `null` means "retry this file". */
const PATCH_STATUS_BY_PUBLICATION: Record<PublicationState, PatchStatus | null> = {
  unpublished: "failed",
  stale: null,
  published: "patched",
  inconsistent: "indeterminate",
};

/** One attempt of the read-mask-verify-rename-recover cycle. `null` = retry. */
function patchThroughDescriptor(
  fd: number,
  filePath: string,
  pepper: string,
  fingerprint: string,
  mask: string,
  attempt: number,
): PatchOutcome | null {
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch {
    return patchOutcome("failed");
  }
  if (!stat.isFile()) return patchOutcome("missing");
  if (stat.size > MAX_SOURCE_PATCH_BYTES) {
    redactionLog("warn", "credential_redaction_source_too_large", {
      file: filePath,
      byte_length: stat.size,
      max_patch_bytes: MAX_SOURCE_PATCH_BYTES,
    });
    return patchOutcome("refused");
  }

  const original = readExactly(fd, 0, stat.size);
  if (original === null) {
    // The file shrank or errored mid-read; re-open and look again.
    return null;
  }

  const masked = maskCredentialInText(
    original.toString("latin1"),
    pepper,
    fingerprint,
    mask,
  );
  // An incomplete scan cannot justify overwriting the operator's transcript.
  if (masked.truncated) return patchOutcome("refused");
  if (masked.replacements === 0) return patchOutcome("unchanged");

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.mandible-redact.${process.pid}.${attempt}.tmp`,
  );
  const discardTemp = (): void => {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best effort: a leftover temp file is not worth failing the report over.
    }
  };
  const finalMode = stat.mode & 0o777;
  // "ax": exclusive create, and every write goes to the current end of file.
  // Append mode is what makes the checkpoint/rewind discipline in tail recovery
  // work — after a rewind the next write continues from the new end instead of
  // from a stale file position, which would leave a hole of NUL bytes.
  let outFd: number;
  try {
    outFd = fs.openSync(tempPath, "ax", finalMode);
  } catch {
    discardTemp();
    return patchOutcome("failed");
  }
  const closeOut = (): void => {
    try {
      fs.closeSync(outFd);
    } catch {
      // A close failure on an already-fsynced descriptor changes nothing.
    }
  };

  // From the successful open to the close in the `finally` below, one block
  // owns the descriptor (issue b3e4a09, fifth-pass item 2). Nothing inside it
  // returns: each step records its result on `outcome`, so there is a single
  // exit and the teardown cannot be skipped by a path added later. The reason
  // it has to be a `finally` rather than a sequence of calls is that the steps
  // are not all guarded — `recoverAppendedTail` reads the unlinked inode, and
  // an EIO there used to travel straight past the mode restore and the close,
  // leaving the replacement published with its creation mode, the descriptor
  // leaked, and the operator holding an exception instead of an account of what
  // did and did not make it onto the file.
  const outcome = patchOutcome("failed");
  const progress: TailProgress = {
    committed: original.length,
    replacements: 0,
    indeterminate: false,
  };
  // The attempt's whole result is this one variable, and `advance` is the only
  // way it moves (issue b3e4a09, sixth-pass item 1). `patched` is not a status
  // this function can decide to set at the end — it is what the mapping below
  // returns for exactly one state, and an append that reported `indeterminate`
  // moves the machine to a state that has no transition back. That is the
  // structural version of "never report an uncertain file as patched": there is
  // no ordering of the steps below, and no step a later edit could add, that
  // reaches `patched` from `inconsistent`.
  let state: PublicationState = "unpublished";
  const advance = (next: PublicationState): void => {
    if (state === "inconsistent") return;
    state = next;
  };
  /** Is the replacement now the file at `filePath`? */
  const isPublished = (): boolean => state === "published" || state === "inconsistent";
  try {
    let staged = false;
    try {
      writeAll(outFd, Buffer.from(masked.text, "latin1"));
      fs.fsyncSync(outFd);
      staged = true;
    } catch {
      // `outcome` is already "failed".
    }

    if (staged && !sourceUnchanged(fd, filePath, original)) {
      redactionLog("warn", "credential_redaction_source_changed", {
        file: filePath,
        attempt,
      });
      staged = false;
      advance("stale");
    }

    if (staged) {
      try {
        fs.renameSync(tempPath, filePath);
        advance("published");
      } catch {
        // `outcome` is already "failed".
      }
    }

    if (isPublished()) {
      // The read descriptor is still open on the now-unlinked inode, which is
      // the only way to see anything a writer appended inside the
      // verify-to-rename window; `outFd` is still the replacement's own
      // descriptor from creation.
      const lastNewline = original.lastIndexOf(0x0a);
      const openTail = original.toString("latin1").slice(lastNewline + 1);
      const maskedLastNewline = masked.text.lastIndexOf("\n");
      recoverAppendedTail({
        fd,
        outFd,
        fromOffset: original.length,
        seam: openTail.length === 0
          ? null
          : {
            source: openTail,
            written: Buffer.from(masked.text.slice(maskedLastNewline + 1), "latin1"),
          },
        pepper,
        fingerprint,
        mask,
      }, progress);
      if (progress.indeterminate) advance("inconsistent");
    }
  } catch (error) {
    // Everything above that can fail in an expected way is already guarded, so
    // reaching here means the filesystem failed in a way this code does not
    // model. It is still not a reason to throw past a published replacement:
    // `progress` holds what recovery had durably committed, and the settlement
    // below turns that into the same recovered/abandoned account any other
    // incomplete recovery produces. Before the rename there is nothing
    // published and the temp file is discarded in the `finally`, so the file
    // is simply reported as failed.
    redactionLog("error", "credential_redaction_source_patch_failed", {
      file: filePath,
      published: isPublished(),
      error: String(error),
    });
  } finally {
    if (isPublished()) {
      // The mode goes back through the same descriptor, so it lands on this
      // run's file whatever the path names by now, and openSync's umask-masked
      // mode argument is corrected in the same call. A failure is reported
      // rather than swallowed: the bytes are in place, but the file is left
      // more permissive than the operator's, and that is not something a
      // security command may hide.
      try {
        fs.fchmodSync(outFd, finalMode);
      } catch (error) {
        outcome.modeRestoreFailed = true;
        redactionLog("error", "credential_redaction_source_mode_restore_failed", {
          file: filePath,
          mode: finalMode.toString(8),
          error: String(error),
        });
      }
    }
    closeOut();
    if (!isPublished()) discardTemp();
  }

  // The exception path can leave `progress` marked without the transition above
  // having run, so the machine is settled once more here — through `advance`,
  // and immediately before the mapping, with nothing in between that could move
  // it back.
  if (progress.indeterminate) advance("inconsistent");
  const status = PATCH_STATUS_BY_PUBLICATION[state];
  if (status === null) return null;
  outcome.status = status;

  if (isPublished()) {
    const tail = settleTail(fd, original.length, progress);
    if (tail.bytes > 0 || tail.abandoned === null || tail.abandoned > 0) {
      redactionLog("warn", "credential_redaction_source_tail_recovered", {
        file: filePath,
        recovered_bytes: tail.bytes,
        recovered_spans: tail.replacements,
        abandoned_bytes: tail.abandoned,
        // Explicit, because `null` in a log line reads as "the field was not
        // filled in" rather than "the number could not be obtained".
        tail_accounting: tail.abandoned === null ? "unknown" : "known",
      });
    }
    outcome.recoveredBytes = tail.bytes;
    outcome.abandonedBytes = tail.abandoned;
    // Spans are only claimed for a file whose contents are known. An
    // indeterminate file may hold a fragment of an append, so counting its
    // masked spans would be reporting a rewrite this code cannot vouch for.
    if (status === "patched") {
      outcome.replacements = masked.replacements + tail.replacements;
    } else {
      redactionLog("error", "credential_redaction_source_indeterminate", {
        file: filePath,
        recovered_bytes: tail.bytes,
        abandoned_bytes: tail.abandoned,
      });
    }
  }
  return outcome;
}

interface BlockRow {
  id: string;
  conversation_id: string;
  content: Buffer | string;
  metadata_json: string | null;
  compressed: number;
  type: string;
  timestamp: string | null;
  position: number;
}

/**
 * Prefix for the intermediate ids a convergence pass parks rows on.
 *
 * Ids are 16 hex characters, so nothing derived can ever equal one of these.
 */
const CONVERGENCE_TEMP_PREFIX = "mandible-redact-tmp:";

interface BlockIdConvergence {
  /** Current id → converged id, for every row this pass moved. */
  renames: Map<string, string>;
  /** Rows left on a non-reproducible id because the pass could not apply. */
  unresolved: number;
}

/**
 * Re-derive one conversation's block ids the way the next full ingest will.
 *
 * Called only when a per-row recomputation found its target id already taken.
 * Row-at-a-time recomputation cannot settle that case: which of two blocks that
 * derive the same id keeps it is a property of the conversation, not of either
 * row, so the answer has to be computed over the whole conversation in position
 * order — exactly what `assignConversationBlockIds` does for ingestion's
 * recovery insert. Running the same function over the same blocks in the same
 * order is what makes redact-then-re-ingest land on identical ids.
 *
 * Content is read back from the rows rather than from the redaction's in-memory
 * batch so the derivation sees precisely the bytes stored, including blocks this
 * run never touched. A row whose content cannot be decompressed makes the fixed
 * point unknowable, so the pass declines rather than guessing.
 *
 * Ids are the primary key, so the moves are applied in two phases through
 * unused placeholder ids: a direct update would collide with the very row it is
 * trying to displace. A target held by some *other* conversation — a real
 * truncated-hash collision — makes the transaction fail, and the conversation is
 * reported as unresolved rather than having another conversation's row taken
 * from it.
 */
function convergeConversationBlockIds(db: Db, conversationId: string): BlockIdConvergence {
  const rows = db
    .prepare(
      `SELECT id, type, timestamp, content, compressed, position
       FROM conversation_blocks WHERE conversation_id = ? ORDER BY position`,
    )
    .all(conversationId) as Array<{
      id: string;
      type: string;
      timestamp: string | null;
      content: Buffer | string;
      compressed: number;
      position: number;
    }>;
  const inputs = [];
  for (const row of rows) {
    let text: string;
    try {
      text = decompressContent(row.content, row.compressed === 1);
    } catch {
      redactionLog("error", "credential_redaction_block_id_convergence_failed", {
        conversation_id: conversationId,
        reason: "unreadable_block_content",
        position: row.position,
      });
      return { renames: new Map(), unresolved: 1 };
    }
    inputs.push({
      conversation_id: conversationId,
      type: row.type,
      timestamp: row.timestamp,
      content: text,
      position: row.position,
    });
  }

  const targets = assignConversationBlockIds(inputs);
  const moves = rows
    .map((row, index) => ({
      from: row.id,
      to: targets[index],
      temp: `${CONVERGENCE_TEMP_PREFIX}${conversationId}:${index}`,
    }))
    .filter((move) => move.from !== move.to);
  if (moves.length === 0) return { renames: new Map(), unresolved: 0 };

  try {
    const update = db.prepare("UPDATE conversation_blocks SET id = ? WHERE id = ?");
    db.transaction(() => {
      for (const move of moves) update.run(move.temp, move.from);
      for (const move of moves) update.run(move.to, move.temp);
    })();
  } catch (error) {
    redactionLog("error", "credential_redaction_block_id_convergence_failed", {
      conversation_id: conversationId,
      reason: "id_held_by_another_conversation",
      moves: moves.length,
      error: String(error),
    });
    return { renames: new Map(), unresolved: moves.length };
  }
  return { renames: new Map(moves.map((move) => [move.from, move.to])), unresolved: 0 };
}

/**
 * Sweep the normalized index for one credential's plaintext and mask it.
 *
 * Search covers every stored block, in `content` and in `metadata_json`: the
 * credential id says nothing about where the token was pasted, the parsers copy
 * tool arguments and short tool results into metadata, and a hash-verified
 * sweep is the only way to find every copy. Rows keep their rowid, so
 * conversation structure, positions, and stable-offset pagination are
 * unaffected — and conversation search, which reads block content directly
 * rather than a separate index, immediately reflects the masked text.
 *
 * Block ids are recomputed (issue b3e4a09, review finding 7). A block id is a
 * hash of the first 100 characters of its content, so a redaction inside that
 * window changes what the next ingest of the patched source will derive.
 * Keeping the plaintext-derived id would leave a link that works now and breaks
 * silently at the next full re-ingest; recomputing moves that change to the
 * moment the operator ran the redaction and makes every link captured
 * afterwards survive re-ingest. Leak alerts that pointed at the old id are
 * repointed in the same pass, so the deep link on the record an operator opens
 * *because* of the leak keeps resolving (re-review finding 2).
 *
 * The recomputed id CAN already belong to another well-formed row, and an
 * earlier round of this file argued otherwise from `UNIQUE(conversation_id,
 * position)` — that argument was wrong (issue b3e4a09, third-pass finding 3).
 * `conversationBlockId` concatenates its inputs with no delimiters and no
 * length framing, so two rows that differ in a hashed input can still hash
 * identical bytes: for one conversation, type, and timestamp, content
 * "payload1" at position 2 and content "payload" at position 12 both serialize
 * to `…payload12`. Positions stay unique and no SHA-256 collision occurs; the
 * ambiguity is in the serialization. Redaction reaches it the moment a mask
 * rewrites a content prefix into the other row's prefix-plus-digits.
 *
 * Keeping the old id in that case was the remaining defect: it left a row on an
 * id nothing can re-derive, so the next full ingest could not reproduce the
 * index. The conflict branch now converges instead — it re-derives the whole
 * conversation's ids with `assignConversationBlockIds`, the same function and
 * the same position order ingestion's unique-conflict recovery uses, so a
 * redact-then-force-re-ingest round trip lands on identical ids. Blocks that
 * are not part of an ambiguous set keep exactly the id the plain derivation
 * gives them, so nothing else is renumbered.
 *
 * Delimiter framing would remove the ambiguity at the root and is deliberately
 * left for a dedicated migration-bearing change: it would alter the id of every
 * block in every existing database at once.
 *
 * Redacting a source that cannot be patched (`--patch-sources` refused or
 * omitted) still diverges at the next re-ingest, because that ingest sees the
 * unredacted bytes again — patching the source is what makes redaction durable.
 */
export function redactCredential(
  db: Db,
  ref: string,
  options: CredentialRedactionOptions = {},
): CredentialRedactionReport {
  const credential = resolveCredentialForRedaction(db, ref);
  const pepper = options.pepper ?? credentialScanPepper(db);
  const mask = credentialMaskFor(credential.id);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  const select = db.prepare(
    `SELECT id, conversation_id, content, metadata_json, compressed,
            type, timestamp, position
     FROM conversation_blocks
     WHERE payload_state = 'legacy'
     ORDER BY rowid
     LIMIT ? OFFSET ?`,
  );
  const update = db.prepare(
    `UPDATE conversation_blocks
     SET content = ?, compressed = 1, metadata_json = COALESCE(?, metadata_json), id = ?
     WHERE id = ?`,
  );
  const idTaken = db.prepare("SELECT 1 AS present FROM conversation_blocks WHERE id = ?");

  const conversations = new Set<string>();
  // Conversations whose source transcript is worth patching. Wider than the set
  // above on purpose: a conversation ingested after ingest-time masking shipped
  // already carries the mask, so its blocks need no edit — but its source file
  // still holds the working token and is exactly what --patch-sources is for.
  const sourceCandidates = new Set<string>();
  for (const row of db.prepare(`
    SELECT DISTINCT json_extract(data_json, '$.conversation_id') AS conversation_id
      FROM webhook_events
     WHERE event_type = 'credential_leak'
       AND json_extract(data_json, '$.credential_id') = ?
       AND json_type(data_json, '$.conversation_id') = 'text'
  `).all(credential.id) as Array<{ conversation_id: string }>) {
    sourceCandidates.add(row.conversation_id);
  }
  if (options.patchSources) {
    // Once transcript payloads have been reclaimed, an older credential may
    // exist only in provider JSONL. Discover those files with a bounded stream
    // instead of materializing every source (one production source is >3 GiB).
    for (const conversationId of discoverSourceBackedCredentialConversations(
      db,
      pepper,
      credential.fingerprint,
    )) sourceCandidates.add(conversationId);
  }
  let scanned = 0;
  let redactedBlocks = 0;
  let redactedSpans = 0;
  let unverifiedSpans = 0;
  let idConflicts = 0;
  let unresolvedIdConflicts = 0;
  let offset = 0;
  let truncated = false;
  /** Old id → new id, for every block whose id this run recomputed. */
  const renamedBlockIds = new Map<string, string>();
  /** Conversations whose ids need re-deriving over the whole conversation. */
  const conflictedConversations = new Set<string>();

  for (;;) {
    const rows = select.all(batchSize, offset) as BlockRow[];
    if (rows.length === 0) break;
    offset += rows.length;

    const pending: Array<{
      id: string;
      newId: string;
      conversationId: string;
      position: number;
      content: Buffer;
      metadataJson: string | null;
    }> = [];
    for (const row of rows) {
      scanned += 1;
      let text: string;
      try {
        text = decompressContent(row.content, row.compressed === 1);
      } catch {
        continue;
      }
      const maskedContent = maskCredentialInText(
        text,
        pepper,
        credential.fingerprint,
        mask,
        { conservative: true },
      );
      const maskedMetadata = row.metadata_json === null
        ? null
        : maskCredentialInText(
          row.metadata_json,
          pepper,
          credential.fingerprint,
          mask,
          { conservative: true },
        );
      truncated ||= maskedContent.truncated || (maskedMetadata?.truncated ?? false);
      const spans = maskedContent.replacements + (maskedMetadata?.replacements ?? 0);
      const unverified = maskedContent.unverified + (maskedMetadata?.unverified ?? 0);
      if (spans + unverified === 0) {
        if (text.includes(mask) || (row.metadata_json ?? "").includes(mask)) {
          sourceCandidates.add(row.conversation_id);
        }
        continue;
      }
      // The id is derived from the first 100 characters of content only, so
      // metadata-only edits and edits past that window cannot change what the
      // next ingest derives and must not churn the id.
      const newId = maskedContent.text.slice(0, 100) === text.slice(0, 100)
        ? row.id
        : conversationBlockId({
          conversation_id: row.conversation_id,
          type: row.type,
          timestamp: row.timestamp,
          content: maskedContent.text,
          position: row.position,
        });
      pending.push({
        id: row.id,
        newId,
        conversationId: row.conversation_id,
        position: row.position,
        content: compressContent(maskedContent.text),
        metadataJson: maskedMetadata && maskedMetadata.text !== row.metadata_json
          ? maskedMetadata.text
          : null,
      });
      redactedBlocks += 1;
      redactedSpans += spans;
      unverifiedSpans += unverified;
      conversations.add(row.conversation_id);
      sourceCandidates.add(row.conversation_id);
    }

    if (pending.length > 0) {
      db.transaction(() => {
        for (const entry of pending) {
          let targetId = entry.id;
          if (entry.newId !== entry.id) {
            if (idTaken.get(entry.newId)) {
              // Reachable through the unframed id serialization (see above).
              // The row keeps its old id here and the conversation is re-derived
              // as a whole once the content edits are in, because which row wins
              // the contested id is not a per-row fact.
              idConflicts += 1;
              conflictedConversations.add(entry.conversationId);
              redactionLog("warn", "credential_redaction_block_id_conflict", {
                conversation_id: entry.conversationId,
                position: entry.position,
                deferred_block_id: entry.id,
              });
            } else {
              targetId = entry.newId;
              renamedBlockIds.set(entry.id, entry.newId);
            }
          }
          update.run(entry.content, entry.metadataJson, targetId, entry.id);
        }
      })();
    }
    if (rows.length < batchSize) break;
  }

  // Contested ids are settled over the whole conversation, from the content now
  // stored, so the result is the id assignment the next full ingest derives.
  for (const conversationId of conflictedConversations) {
    const converged = convergeConversationBlockIds(db, conversationId);
    unresolvedIdConflicts += converged.unresolved;
    // Compose with this run's earlier renames so a block moved twice is still
    // followed from the id its leak alert recorded.
    for (const [from, to] of renamedBlockIds) {
      const final = converged.renames.get(to);
      if (final === undefined) continue;
      renamedBlockIds.set(from, final);
      converged.renames.delete(to);
    }
    for (const [from, to] of converged.renames) renamedBlockIds.set(from, to);
  }
  for (const [from, to] of renamedBlockIds) {
    if (from === to) renamedBlockIds.delete(from);
  }
  const renumberedBlocks = renamedBlockIds.size;

  // Leak alerts deep-link the block a credential was found in, so renumbering
  // without following them leaves the alert pointing at a deleted id.
  const remappedAlerts = remapCredentialLeakAlertBlockIds(db, renamedBlockIds);

  const metadata = redactConversationMetadata(
    db,
    pepper,
    credential.fingerprint,
    mask,
    conversations,
    sourceCandidates,
  );
  redactedSpans += metadata.spans;
  unverifiedSpans += metadata.unverified;
  truncated ||= metadata.truncated;

  const sources = options.patchSources
    ? patchSourcesForConversations(db, [...sourceCandidates], pepper, credential.fingerprint, mask)
    : null;

  redactionLog("warn", "credential_redaction_completed", {
    credential_id: credential.id,
    credential_status: credential.status,
    scanned_blocks: scanned,
    redacted_blocks: redactedBlocks,
    redacted_metadata_fields: metadata.fields,
    redacted_spans: redactedSpans,
    unverified_spans: unverifiedSpans,
    redacted_conversations: conversations.size,
    renumbered_blocks: renumberedBlocks,
    id_conflicts: idConflicts,
    unresolved_id_conflicts: unresolvedIdConflicts,
    remapped_leak_alerts: remappedAlerts,
    truncated,
    patched_files: sources?.patched_files ?? null,
    missing_files: sources?.missing_files ?? null,
    failed_files: sources?.failed_files ?? null,
    indeterminate_files: sources?.indeterminate_files ?? null,
    refused_files: sources?.refused_files ?? null,
    recovered_tail_bytes: sources?.recovered_tail_bytes ?? null,
    abandoned_tail_bytes: sources?.abandoned_tail_bytes ?? null,
    unknown_tail_files: sources?.unknown_tail_files ?? null,
    mode_restore_failed_files: sources?.mode_restore_failed_files ?? null,
  });

  return {
    credential_id: credential.id,
    credential_status: credential.status,
    scanned_blocks: scanned,
    redacted_blocks: redactedBlocks,
    redacted_metadata_fields: metadata.fields,
    redacted_spans: redactedSpans,
    unverified_spans: unverifiedSpans,
    redacted_conversations: conversations.size,
    renumbered_blocks: renumberedBlocks,
    id_conflicts: idConflicts,
    unresolved_id_conflicts: unresolvedIdConflicts,
    remapped_leak_alerts: remappedAlerts,
    truncated,
    sources,
  };
}

/**
 * Mask the credential in conversation titles and summaries.
 *
 * These are derived from block text, so a token pasted into a first user
 * message lands here too. They are plain TEXT columns rather than compressed
 * blobs, so the scan can be pushed into SQL.
 */
function redactConversationMetadata(
  db: Db,
  pepper: string,
  fingerprint: string,
  mask: string,
  changed: Set<string>,
  sourceCandidates: Set<string>,
): { fields: number; spans: number; unverified: number; truncated: boolean } {
  const rows = db
    .prepare(
      `SELECT id, title, summary FROM conversations
       WHERE (title IS NOT NULL AND (title LIKE ? OR title LIKE ?))
          OR (summary IS NOT NULL AND (summary LIKE ? OR summary LIKE ?))`,
    )
    .all(
      `%${TOKEN_PREFIX_PATTERN}%`,
      `%${mask}%`,
      `%${TOKEN_PREFIX_PATTERN}%`,
      `%${mask}%`,
    ) as Array<{ id: string; title: string | null; summary: string | null }>;

  const update = db.prepare("UPDATE conversations SET title = ?, summary = ? WHERE id = ?");
  const conservative = { conservative: true } as const;
  let fields = 0;
  let spans = 0;
  let unverified = 0;
  let truncated = false;
  for (const row of rows) {
    const title = maskCredentialInText(row.title ?? "", pepper, fingerprint, mask, conservative);
    const summary = maskCredentialInText(
      row.summary ?? "",
      pepper,
      fingerprint,
      mask,
      conservative,
    );
    truncated ||= title.truncated || summary.truncated;
    const titleSpans = title.replacements + title.unverified;
    const summarySpans = summary.replacements + summary.unverified;
    const carriesMask = (row.title ?? "").includes(mask) || (row.summary ?? "").includes(mask);
    if (titleSpans === 0 && summarySpans === 0) {
      if (carriesMask) sourceCandidates.add(row.id);
      continue;
    }
    update.run(
      row.title === null ? null : title.text,
      row.summary === null ? null : summary.text,
      row.id,
    );
    fields += (titleSpans > 0 ? 1 : 0) + (summarySpans > 0 ? 1 : 0);
    spans += title.replacements + summary.replacements;
    unverified += title.unverified + summary.unverified;
    changed.add(row.id);
    sourceCandidates.add(row.id);
  }
  return { fields, spans, unverified, truncated };
}

/**
 * Find source-backed conversations containing one credential without loading
 * whole provider logs into memory. A truncated candidate scan is treated as a
 * possible match so the destructive patcher can refuse it explicitly rather
 * than silently declaring the source clean.
 */
function discoverSourceBackedCredentialConversations(
  db: Db,
  pepper: string,
  fingerprint: string,
): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT c.source_path, c.id AS conversation_id
      FROM conversations c
      JOIN conversation_sources source ON source.conversation_id = c.id
     WHERE source.current_version_id IS NOT NULL
       AND c.source_path IS NOT NULL
     ORDER BY c.source_path, c.id
  `).all() as Array<{ source_path: string; conversation_id: string }>;
  const conversationsByPath = new Map<string, string[]>();
  for (const row of rows) {
    const ids = conversationsByPath.get(row.source_path) ?? [];
    ids.push(row.conversation_id);
    conversationsByPath.set(row.source_path, ids);
  }

  const matches = new Set<string>();
  for (const [filePath, conversationIds] of conversationsByPath) {
    if (!sourceMayContainCredential(filePath, pepper, fingerprint)) continue;
    for (const conversationId of conversationIds) matches.add(conversationId);
  }
  return matches;
}

function sourceMayContainCredential(
  filePath: string,
  pepper: string,
  fingerprint: string,
): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    // Let the existing patch/report path classify missing and unreadable files
    // when another durable clue already points to them. An otherwise unknown
    // unreadable source cannot be safely claimed to contain this credential.
    return false;
  }
  try {
    const buffer = Buffer.allocUnsafe(SOURCE_DISCOVERY_CHUNK_BYTES);
    let offset = 0;
    let overlap = "";
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (read <= 0) return false;
      offset += read;
      const text = overlap + buffer.subarray(0, read).toString("latin1");
      const extracted = extractTokenCandidatesWithStatus(text);
      for (const candidate of extracted.candidates) {
        if (fingerprintForToken(pepper, candidate) === fingerprint) return true;
      }
      if (extracted.truncated) return true;
      overlap = text.slice(-SOURCE_DISCOVERY_OVERLAP);
    }
  } catch (error) {
    redactionLog("warn", "credential_redaction_source_discovery_failed", {
      file: filePath,
      error: String(error),
    });
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Read-only descriptor; nothing further is recoverable here.
    }
  }
}

function patchSourcesForConversations(
  db: Db,
  conversationIds: readonly string[],
  pepper: string,
  fingerprint: string,
  mask: string,
): CredentialRedactionSourceReport {
  const report: CredentialRedactionSourceReport = {
    candidate_files: 0,
    patched_files: 0,
    unchanged_files: 0,
    missing_files: 0,
    failed_files: 0,
    indeterminate_files: 0,
    refused_files: 0,
    patched_spans: 0,
    recovered_tail_bytes: 0,
    abandoned_tail_bytes: 0,
    unknown_tail_files: 0,
    mode_restore_failed_files: 0,
  };
  if (conversationIds.length === 0) return report;

  const lookup = db.prepare("SELECT source_path FROM conversations WHERE id = ?");
  const files = new Set<string>();
  for (const id of conversationIds) {
    const row = lookup.get(id) as { source_path: string | null } | undefined;
    if (row?.source_path) files.add(row.source_path);
  }
  report.candidate_files = files.size;

  for (const file of files) {
    const outcome = patchSourceFile(file, pepper, fingerprint, mask);
    report.recovered_tail_bytes += outcome.recoveredBytes;
    // An unmeasurable tail is counted as a file, not added as a zero: a sum can
    // only carry numbers that exist.
    if (outcome.abandonedBytes === null) report.unknown_tail_files += 1;
    else report.abandoned_tail_bytes += outcome.abandonedBytes;
    if (outcome.modeRestoreFailed) report.mode_restore_failed_files += 1;
    switch (outcome.status) {
      case "patched":
        report.patched_files += 1;
        report.patched_spans += outcome.replacements;
        break;
      case "unchanged":
        report.unchanged_files += 1;
        break;
      case "missing":
        report.missing_files += 1;
        break;
      case "refused":
        report.refused_files += 1;
        break;
      case "indeterminate":
        report.indeterminate_files += 1;
        break;
      default:
        report.failed_files += 1;
        break;
    }
  }
  return report;
}

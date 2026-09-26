/**
 * Citation identity.
 *
 * A citation id is a pure function of (snapshot, block, exact quote). Two
 * processes that parse the same bytes derive the same id, and a citation stops
 * verifying as soon as the underlying bytes change.
 *
 * That is the right property for pinning a derivation and the wrong one for a
 * citation that has to outlive it. Every input to the id above is an output of
 * the parse: a parser version bump produces new block ids, new byte offsets and
 * a new snapshot id, so 94 of 100 pinned snapshots in a 100-protocol corpus had
 * to be re-pinned after a routine bump, and a citation written into a contract
 * or a bug report could not be re-verified afterwards — `verify_citation`
 * answered `not_found` and the reader had no way to learn what the text was.
 *
 * So there is a second identifier, and it hashes only what a re-parse does not
 * change: the RFC number, the section NUMBER, the quoted text, and which
 * occurrence of that text in the section it is. Both are handed out; they are
 * not interchangeable and their prefixes say so.
 */

import { sha256Hex, shortHash } from "../core/util.js";

export function quoteHash(quote: string): string {
  return `sha256:${sha256Hex(quote)}`;
}

export function citationId(input: {
  readonly snapshotId: string;
  readonly blockId: string;
  readonly byteStart: number;
  readonly quote: string;
}): string {
  return `cit_${shortHash(`${input.snapshotId}|${input.blockId}|${input.byteStart}|${sha256Hex(input.quote).slice(0, 32)}`)}`;
}

/**
 * Prefix of the re-derivation-stable id.
 *
 * `cit_` + 24 hex is the snapshot-scoped id and a reader must never be left
 * guessing which of the two it is holding, so the second prefix starts with a
 * different character and is longer. `scit_` cannot be read as `cit_`, and it
 * fails every pattern that accepts the first form, so a caller that validates
 * ids by shape rejects the wrong kind instead of looking it up and finding
 * nothing.
 */
export const STABLE_CITATION_PREFIX = "scit_";

/** The snapshot-scoped id, by shape. Kept beside the stable pattern on purpose. */
export const SNAPSHOT_CITATION_PATTERN = /^cit_[0-9a-f]{24}$/u;

export const STABLE_CITATION_PATTERN = /^scit_[0-9a-f]{24}$/u;

/** Which kind of identifier a caller handed in, decided by shape and nothing else. */
export function citationIdKind(value: string): "snapshot_scoped" | "stable" | "unrecognized" {
  if (STABLE_CITATION_PATTERN.test(value)) return "stable";
  if (SNAPSHOT_CITATION_PATTERN.test(value)) return "snapshot_scoped";
  return "unrecognized";
}

/**
 * An identifier that survives re-derivation.
 *
 * Every input here is content the RFC Editor published, not something the parse
 * produced: a document number, a section number a reader can look up, and the
 * exact quoted text. A parser or extractor version bump changes block ids, byte
 * offsets and the snapshot id; it changes none of these, so the id survives it
 * and a citation recorded in a contract can still be checked against the
 * re-derived document.
 *
 * `sectionNumber` is the NUMBER, not a block id: "4.3.1", "Appendix A". That is
 * a string an RFC's own table of contents prints, so it is stable where a block
 * id is not.
 *
 * `occurrence` orders duplicates. The same sentence can appear twice in one
 * section, and an id with no occurrence index would be one id with two referents;
 * `0` and `1` are two ids for two places. It changes nothing about verification —
 * the id names a sentence, not a position, and `verify_citation` reports both
 * places rather than guessing — but it lets a caller that DID count keep the two
 * apart in its own records.
 */
export function stableCitationId(input: {
  readonly rfc: number;
  readonly sectionNumber: string;
  readonly quote: string;
  readonly occurrence?: number;
}): string {
  const occurrence = input.occurrence ?? 0;
  return `${STABLE_CITATION_PREFIX}${shortHash(
    `rfc${input.rfc}|${input.sectionNumber}|${sha256Hex(input.quote).slice(0, 32)}|${occurrence}`,
  )}`;
}

/**
 * The text hash a stored `text_sha256` column already holds.
 *
 * Resolution has to compare derived sentences against stored text, and the two
 * must be the same function or nothing will ever match: `parseRfcText` writes
 * `sha256Hex(text)` into `sections.text_sha256` and `blocks.text_sha256`, and a
 * sentence is just a shorter piece of that same text.
 */
export function textHash(text: string): string {
  return sha256Hex(text);
}

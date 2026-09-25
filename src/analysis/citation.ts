/**
 * Citation identity.
 *
 * A citation id is a pure function of (snapshot, block, exact quote). Two
 * processes that parse the same bytes derive the same id, and a citation stops
 * verifying as soon as the underlying bytes change.
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

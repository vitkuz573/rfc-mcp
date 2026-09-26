// The floor: extractors that do no extraction.
//
// This file exists because of a measurement, not a worry. A 3-line grep - split a
// section into sentences, keep the ones containing a modal token, print them - scored
// 118/118 on strict recall and 129/129 on weak recall against the golden set, with
// `run-bench.mjs`'s own matcher, unchanged. The real tool scored 91.5% and 84.5%. A
// number a grep beats is not a measurement, and the only way the next reader finds that
// out is if the instrument says so on every run. So the harness scores these on the same
// golden set, with the same matcher, and prints them beside the tool.
//
// WHY THE FLOOR IS NOT OPTIONAL. The floor is not a sanity check that a healthy build
// passes. It is the value below which a reported percentage carries no information: a
// reader who knows the floor is 100% learns that 91.5% is a failure, and a reader who
// does not learn nothing from either number. `run-bench.mjs` prints VOID rather than the
// percentage when the tool is at or below the best floor, because a bare number next to
// a known floor is the trap this file closes.
//
// WHY SPLITTERS ARE PART OF THE FLOOR AND NOT A DETAIL. The same three lines score 100%
// with the splitter `labelling.mjs` itself uses and 3.1% with a splitter that also breaks
// at line ends - which is the right thing to do on hard-wrapped RFC text. Recall was
// therefore set by whether the candidate extractor's sentence boundaries agreed with the
// labeller's, not by whether it found the statement. That is a property of the labeller,
// published here as `punct`, and a measurement of it belongs next to the measurement.

import { norm } from "./labelling.mjs";

/**
 * Sentence boundary rules, in the order they are tried.
 *
 * `punct` is the splitter `labelling.mjs` uses, and therefore the one a trivial
 * extractor is most likely to agree with by construction. `dot` and `punct_or_newline`
 * are the other two the red team ran. `none` is the degenerate end: no split at all.
 */
export const SPLITTERS = {
  punct: {
    re: /(?<=[.!?])\s+/u,
    why: "the splitter labelling.mjs itself uses, so a probe and its floor-case extractor agree by construction",
  },
  dot: {
    re: /\.\s+/u,
    why: "period followed by whitespace only: no boundary at a question mark, an exclamation, or a line end",
  },
  punct_or_newline: {
    re: /(?<=[.!?])\s+|\n+/u,
    why: "hard-wrapped RFC text also breaks at a line end, which is what a reader sees",
  },
  none: { re: null, why: "no sentence split at all" },
};

/** Modal token, any case, standalone word. The whole of floor extractor F1. */
const MODAL_CI = /\b(?:must|shall|should|may|required|recommended|optional)\b/iu;

const row = (exact_text, extra) => ({ exact_text, ...extra });

/**
 * F1: every sentence in the section that contains a modal token, any case.
 *
 * Three lines of policy: split, test, print. No block classification, no prose/table
 * judgement, no action-verb test, no RFC 2119 case test, no ranking, no shape, no role.
 * It cannot tell a strict row from a provisional one, so it offers every row to both
 * pools and the bench decides which pool to look in. That is the point: a floor does not
 * get to be right about tiers, or it would be a real extractor.
 */
export function f1ModalSentences(text, splitter) {
  const spec = SPLITTERS[splitter];
  if (!spec) throw new Error(`unknown splitter ${splitter}`);
  if (spec.re === null) return [row(norm(text), { splitter, origin: "whole_section" })];
  return String(text ?? "")
    .split(spec.re)
    .map(norm)
    .filter((n) => n.length > 0 && MODAL_CI.test(n))
    .map((n) => row(n, { splitter, origin: "modal_sentence" }));
}

/**
 * F3: every block that contains a modal token, unsplit.
 *
 * Trivial in a different direction from F1: it does not even know where a sentence ends,
 * so it inherits whatever the parser decided a block is. It is the floor for "did you
 * even look at the right blocks", which F1 cannot distinguish from sentence splitting.
 */
export function f3ModalBlocks(blocks) {
  return (blocks ?? [])
    .filter((b) => MODAL_CI.test(String(b.text ?? "")))
    .map((b) => row(norm(b.text), { origin: "modal_block", block_id: b.id, block_kind: b.kind }));
}

/**
 * F2: one row per section, carrying the whole section as `exact_text`.
 *
 * The most trivial extractor that can score, and it exists because it shows the matcher
 * was the problem rather than the extractor. Containment matching is
 * `norm(row).includes(norm(probe))`: a row that contains the whole document contains
 * every probe cut from that document, so this scores 100% on every tier including the
 * keyword-free one, for an extractor that reads nothing. Under the bounded matcher in
 * `eval/lib/match.mjs` it scores what a grep scores, which is the demonstration that the
 * bound is what does the work.
 */
export function f2WholeSection(text) {
  const n = norm(text);
  return n.length === 0 ? [] : [row(n, { origin: "whole_section" })];
}

/**
 * The floor set, in increasing triviality: F1 splits and filters, F3 filters without
 * splitting, F2 does neither. Reported in this order so the trend is legible - a higher
 * score from a MORE trivial extractor is a statement about the matcher.
 */
export const FLOOR_EXTRACTORS = [
  {
    key: "F1_modal_sentence",
    what: "every sentence containing a modal token, any case, split on the labeller's own boundary rule",
    lines: 3,
    perSection: (ctx) => f1ModalSentences(ctx.text, "punct"),
  },
  {
    key: "F3_modal_block",
    what: "every block containing a modal token, unsplit - no idea where a sentence ends",
    lines: 3,
    perBlock: (ctx) => f3ModalBlocks(ctx.blocks),
  },
  {
    key: "F2_whole_section",
    what: "one row per section, carrying the whole section; no split, no keyword test at all",
    lines: 2,
    perSection: (ctx) => f2WholeSection(ctx.text),
  },
];

export const FLOOR_BY_KEY = new Map(FLOOR_EXTRACTORS.map((f) => [f.key, f]));

/** Rows one floor extractor emits over every section of one protocol. */
export function floorRows(protocolSections) {
  const out = new Map();
  for (const f of FLOOR_EXTRACTORS) {
    const rows = [];
    for (const s of protocolSections) {
      const per = f.perSection ? f.perSection(s) : f.perBlock(s);
      for (const r of per) rows.push({ ...r, section: s.section });
    }
    out.set(f.key, rows);
  }
  return out;
}

/** The same three lines under a different sentence-boundary rule. */
export function splitterSensitivityRows(protocolSections) {
  return Object.keys(SPLITTERS).map((name) => {
    const rows = [];
    for (const s of protocolSections)
      for (const r of f1ModalSentences(s.text, name)) rows.push({ ...r, section: s.section });
    return { splitter: name, why: SPLITTERS[name].why, rows };
  });
}

// Two matchers, and the reason there are two.
//
// The bench used to ask one question: is the probe a substring of the row? That is the
// right question for a probe cut from a section and a row the tool emitted from the same
// section, and it is the wrong question for an INSTRUMENT: a row that carries the whole
// section contains every probe cut from that section, so the degenerate extractor - one
// row per section, no split, no keyword test - scored 260/260 = 100% on every tier. The
// harness measured containment, and containment is not extraction.
//
// So the new matcher asks whether the row is a STATEMENT CONTAINING THE PROBE: the probe
// must be a normalised substring of the row (unchanged) AND the row may not exceed the
// probe by more than a stated margin. Both matchers run on every rule on every run and
// both are reported, because a change in the numbers must be attributable to the matcher
// and not to the tool. The old one is the control.
//
// The margin is a length ratio, not a character budget, so it behaves the same on a
// 45-character probe and a 250-character one. 1.5 is a statement, not a fit: a row that is
// 50% longer than the probe is a different statement that happens to contain it, and the
// bench cannot tell one from the other by asking. MARGIN_SWEEP is published because the
// margin is a judgement and a reader is entitled to see the number move with it.

import { norm } from "./labelling.mjs";

/** Reported margin. A row may exceed the probe by at most this factor. */
export const MATCH_MARGIN = 1.5;

/** Every margin the bench reports, so the sensitivity of the headline to the choice is visible. */
export const MARGIN_SWEEP = [1, 1.25, 1.5, 2, Infinity];

/** Ratios, sorted, for the distribution of how much row a hit really needed. */
function quantiles(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return {
    min: Math.round(q(0) * 1000) / 1000,
    q25: Math.round(q(0.25) * 1000) / 1000,
    median: Math.round(q(0.5) * 1000) / 1000,
    q75: Math.round(q(0.75) * 1000) / 1000,
    max: Math.round(q(1) * 1000) / 1000,
  };
}

/**
 * Does one row match one probe under the bounded matcher?
 * Returns the ratio so the caller can report what the bound is actually doing.
 */
export function statementMatch(rowText, probe, margin = MATCH_MARGIN) {
  const r = norm(rowText);
  const p = norm(probe);
  if (p.length === 0 || !r.includes(p))
    return { hit: false, contains: false, ratio: null, lenRow: r.length, lenProbe: p.length };
  const ratio = r.length / p.length;
  return {
    hit: ratio <= margin,
    contains: true,
    ratio: Math.round(ratio * 1000) / 1000,
    lenRow: r.length,
    lenProbe: p.length,
  };
}

/** The old matcher, verbatim: containment, no bound. Kept as the control. */
export function containmentMatch(rowText, probe) {
  return norm(rowText).includes(norm(probe));
}

/**
 * Find matching rows under a margin, and report the matches a bound EXCLUDED rather than
 * dropping them. An excluded match is a finding: it is a row that would have carried the
 * probe and is longer than the bench is willing to call a statement.
 */
export function findBounded(items, probe, margin = MATCH_MARGIN) {
  const p = norm(probe);
  const hits = [];
  const excluded = [];
  for (const it of items) {
    const m = statementMatch(it.exact_text, probe, margin);
    if (!m.contains) continue;
    const rec = { item: it, ratio: m.ratio, lenRow: m.lenRow, lenProbe: m.lenProbe };
    if (m.hit) hits.push(rec);
    else excluded.push(rec);
  }
  return { hits, excluded };
}

/** Containment matches with no bound, same record shape, so the two are comparable. */
export function findUnbounded(items, probe) {
  const hits = [];
  for (const it of items) {
    const m = statementMatch(it.exact_text, probe, Infinity);
    if (!m.contains) continue;
    hits.push({ item: it, ratio: m.ratio, lenRow: m.lenRow, lenProbe: m.lenProbe });
  }
  return { hits, excluded: [] };
}

/** Byte-exact containment, the control for the whitespace normalisation. */
export function findExact(items, probe) {
  return {
    hits: items.filter((it) => String(it.exact_text ?? "").includes(probe)).map((it) => ({ item: it, ratio: 1 })),
    excluded: [],
  };
}

export { quantiles };

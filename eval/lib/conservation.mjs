// Conservation: is any keyword-bearing sentence invisible, and is every reach true?
//
// WHAT THIS FILE IS NOT. `eval/results/pending-fixes.md` (Y5) proposed one invariant:
//
//   for every section, the set of sentences in `requirements` plus the set in
//   `non_strict_candidates` must cover every keyword-bearing sentence in the section's
//   `text`.
//
// `eval/audit/conservation.md` falsified that sentence as worded - it fails for 506 of
// 5 776 sections - and then said what it would defend instead: three separate label-free
// invariants, R1 reach, R2 fidelity, R3 conservation of the budget, with the reason each
// one is separate. This file implements that report's conclusion, in the form the current
// response shape allows, and names the arm it cannot implement.
//
// The shape is right and the instinct behind it is right: a caller who reads a section and
// then asks for its requirements must not get less than they just read, with nothing in the
// response to explain the difference. Recall cannot see this, because its probes are cut
// from `read(section).text` - the same view the caller read - so every dropped sentence is
// a miss with the same shape as an extraction failure and no way to tell them apart.
//
// R1 is deliberately weaker than a conservation law, in three named ways, each of which
// makes the reported number OPTIMISTIC rather than flattering:
//
//   * "cover" is split into four arms - reached as a statement, reached as a classified
//     mention, reached as a fragment, and NOT REACHED. Only the first is coverage; the
//     second and third are reaches that say they are not requirements, and the fourth is
//     the gap. Y5-as-worded scored the last three the same, which is how a section full of
//     bibliography entries could satisfy it.
//   * the fourth arm R1 asks for - a per-sentence `not_classified` list with a reason from a
//     closed vocabulary - is NOT IMPLEMENTED HERE, because it is a change to the response
//     shape and this harness only reads. The unreached set is reported with a block-kind
//     attribution instead, which is weaker evidence than a reason the tool itself gave.
//   * rows are collected over EVERY page. A caller holding page 1 has a strict subset of
//     that, so this number is the best case for the tool, not the typical one.
//
// Matching here is containment in ONE direction and it must be: the question is whether
// the sentence is accounted for anywhere in the lists, and a row carrying the whole
// paragraph accounts for the sentence inside it. That is the opposite requirement from
// recall's, where a row carrying the whole paragraph is a defect. Two questions, two
// matchers, and the reason is written down so nobody "unifies" them later.

import { candidates, norm } from "./labelling.mjs";

/** Every modal token, in any case, for the strict pass and the candidate pass together.
 *
 *  One predicate and one case semantics. The tool's own counter
 *  (`keyword_bearing_blocks_skipped`) tests an upper-case-only vocabulary with a
 *  case-sensitive regex, while its candidate pass selects blocks with a case-folding SQL
 *  LIKE, so a body paragraph carrying only a lower-case permission is dropped by neither
 *  count and reported by neither. A conservation check written on the strict pass's
 *  predicate would inherit exactly that blindness, which is the defect it exists to find. */
const KEYWORD_BEARING = /\b(?:must|shall|should|may|required|recommended|optional)\b/iu;

/** Blocks the parser typed as something other than prose. */
const NON_PROSE = new Set(["table", "figure", "reference_entry", "preformatted", "heading", "unknown"]);

/** The kinds the strict pass scans. */
const PROSE = new Set(["paragraph", "list_item"]);

/**
 * No length floor. The positive set needs one - a 45-character minimum is what keeps a
 * fragment out of the recall denominator - and importing it here would quietly make
 * conservation a weaker claim than it looks. The question here is whether a keyword-
 * bearing sentence is accounted for anywhere, and "It is a MUST." is a sentence. The
 * length of the unreached set is reported instead of filtered on, so a reader who thinks
 * the short ones are fragments can discount them without the harness doing it silently.
 */
const MIN_CHARS = 1;

/** R2. The keyword forms that are negative as written. Read off the keyword string, not off
 *  `polarity` - the field under test cannot also be one of the two inputs to the test. */
const NEGATIVE_FORMS = new Set(["MUST NOT", "SHALL NOT", "SHOULD NOT", "NOT RECOMMENDED"]);

/** Not in the extractor's vocabulary; counted, never judged. See `vocabulary_out`. */
const MAY_NOT = /\bMAY\s+NOT\b/iu;
const NOT_REQUIRED = /\bNOT\s+REQUIRED\b/iu;

// -------------------------------------------------------------------------------------
// R1 - reach
// -------------------------------------------------------------------------------------

/** The response channel names, and the arm each one credits. */
const ARM_OF = { requirements: "requirement", candidates: "candidate", fragments: "fragment", mentions: "mention" };

/**
 * @param sections `[{ rfc, section, text, blocks }]` for one protocol
 * @param channels `{ requirements, candidates, fragments, mentions }`, pooled over every
 *        page. Section attribution is checked against the row's own `section`, so a row
 *        that carries the right sentence from the wrong section does not count - which is
 *        the failure the audit names when a probe in section 12 is matched by a row in
 *        section 7.
 */
export function sectionReach(sections, channels) {
  const pools = Object.entries(channels)
    .filter(([name]) => ARM_OF[name])
    .map(([name, rows]) => [
      ARM_OF[name],
      (rows ?? []).map((r) => ({ n: norm(r.exact_text), section: r.section ?? null })),
    ]);
  const out = [];
  for (const s of sections) {
    const blockNorms = (s.blocks ?? [])
      .filter((b) => String(b.text ?? "").trim().length > 0)
      .map((b) => ({ kind: b.kind, n: norm(b.text ?? "") }))
      .sort((a, b) => b.n.length - a.n.length);
    const bearing = candidates(s.text)
      .map((c) => c.exact)
      .filter((n) => n.length >= MIN_CHARS && KEYWORD_BEARING.test(n));
    const arms = { requirement: 0, candidate: 0, fragment: 0, mention: 0, unreached: 0 };
    const unreached = [];
    for (const sentence of bearing) {
      let landed = null;
      for (const [name, pool] of pools) {
        // Attribution: the row must claim this sentence in THIS section. A row that carries
        // the text from somewhere else is not a reach for this section.
        if (pool.some((r) => r.n.includes(sentence) && (r.section === null || r.section === s.section))) {
          landed = name;
          break;
        }
      }
      if (landed === null) {
        // "in no block at all" is a different defect from "in a block the tool declines to
        // scan", so it gets its own bucket rather than being counted as prose. Attribution
        // runs in BOTH directions and the longest block wins: the text view flattens, so a
        // table row arrives inside a sentence longer than the block, and a one-directional
        // search would call the whole thing a parser disagreement.
        const host = blockNorms.find((b) => b.n.includes(sentence)) ?? blockNorms.find((b) => sentence.includes(b.n));
        const kind = host ? host.kind : "text_view_only";
        arms.unreached += 1;
        unreached.push({
          rfc: s.rfc,
          section: s.section,
          text: sentence.slice(0, 180),
          chars: sentence.length,
          block_kind: kind,
          declared: host ? NON_PROSE.has(host.kind) : false,
        });
        continue;
      }
      arms[landed] += 1;
    }
    out.push({ rfc: s.rfc, section: s.section, keyword_bearing: bearing.length, arms, unreached });
  }
  return out;
}

/** Pool R1. `coverage_pct` counts only the first arm: only that one is coverage. */
export function poolReach(perSection) {
  const total = perSection.reduce((a, r) => a + r.keyword_bearing, 0);
  const arms = perSection.reduce((a, r) => {
    for (const [k, n] of Object.entries(r.arms)) a[k] = (a[k] ?? 0) + n;
    return a;
  }, {});
  const all = perSection.flatMap((r) => r.unreached);
  const undeclared = all.filter((i) => !i.declared && i.block_kind !== "text_view_only");
  const textOnly = all.filter((i) => i.block_kind === "text_view_only");
  return {
    sections: perSection.length,
    keyword_bearing_sentences: total,
    arms,
    coverage_pct: total === 0 ? null : Math.round((1000 * (arms.requirement ?? 0)) / total) / 10,
    any_reach_pct: total === 0 ? null : Math.round((1000 * (total - (arms.unreached ?? 0))) / total) / 10,
    unreached: arms.unreached ?? 0,
    unreached_by_block_kind: all.reduce((acc, i) => ({ ...acc, [i.block_kind]: (acc[i.block_kind] ?? 0) + 1 }), {}),
    undeclared: {
      count: undeclared.length,
      share_of_unreached_pct:
        (arms.unreached ?? 0) === 0 ? null : Math.round((1000 * undeclared.length) / arms.unreached) / 10,
      under_45_chars: undeclared.filter((i) => i.chars < 45).length,
      why: "a sentence no row in any channel accounts for, whose block is prose. The tool's own counters do not report these, so a caller cannot see them. This is the part that means something is wrong rather than something was decided.",
    },
    text_view_only: {
      count: textOnly.length,
      share_of_unreached_pct:
        (arms.unreached ?? 0) === 0 ? null : Math.round((1000 * textOnly.length) / arms.unreached) / 10,
      why: "present in read(section).text and in NO block. The text view and the block view disagree, so a caller reading the text sees a sentence no query can return. 10.4% of the golden probes are in this state, which is the same bias measured from the other end: the recall denominator is padded with sentences no block-classifying extractor can reach at any quality.",
    },
    worst_sections: perSection
      .filter((r) => r.arms.unreached > 0)
      .sort(
        (a, b) =>
          b.unreached.filter((i) => !i.declared && i.block_kind !== "text_view_only").length -
            a.unreached.filter((i) => !i.declared && i.block_kind !== "text_view_only").length ||
          b.arms.unreached - a.arms.unreached,
      )
      .slice(0, 12)
      .map((r) => [
        r.rfc,
        r.section,
        r.arms.unreached,
        r.unreached.filter((i) => !i.declared && i.block_kind !== "text_view_only").length,
      ]),
    undeclared_examples: all.slice(0, 16).map((i) => [i.rfc, i.section, i.block_kind, i.text]),
  };
}

// -------------------------------------------------------------------------------------
// R2 - fidelity
// -------------------------------------------------------------------------------------

/**
 * A coverage law cannot see this: a row that states the OPPOSITE of the sentence it quotes
 * is a perfect reach. The audit found rows that invert their own sentence on `<UPPER> not`
 * and on `MAY NOT`, and every one of them satisfies Y5. Reach and fidelity are two
 * invariants because one of them is passed by the other's failures.
 *
 * The test is the polarity asserted for the row's PRIMARY keyword against that keyword as
 * it is written, read at the row's own offset - not against the sentence, because a
 * sentence routinely holds two keywords of opposite polarity ("... MUST accept every
 * format, and MUST NOT generate illegal syntax") and judging the whole sentence flags
 * every one of those as inverted when the row is about the first clause. The row hands over
 * `keywords[0].char_start` and `span.char_start` in the same coordinate system, so the
 * text after that keyword is read rather than guessed.
 *
 * `MAY NOT` and `NOT REQUIRED` are deliberately NOT treated as keywords here: adding them
 * is a change to the extractor, and a checker that borrows the tool's own vocabulary is not
 * a checker. They are named in `vocabulary_out` instead, with the count of rows that turn on
 * them, so the gap is a number rather than an omission.
 */
export function fidelity(rows) {
  const disagreements = [];
  const outOfVocabulary = { rows: 0, may_not: 0, not_required: 0, asserted_positive: 0 };
  let checked = 0;
  let fellBack = 0;
  for (const r of rows ?? []) {
    const text = norm(r.exact_text);
    const kw = (r.keywords ?? [])[0] ?? null;
    const primary = kw?.term ?? r.term ?? null;
    if (primary === null || kw === null) continue;
    checked += 1;
    if (MAY_NOT.test(text)) {
      outOfVocabulary.rows += 1;
      outOfVocabulary.may_not += 1;
      if (r.polarity !== "negative") outOfVocabulary.asserted_positive += 1;
    }
    if (NOT_REQUIRED.test(text)) outOfVocabulary.not_required += 1;

    const asserted = r.polarity ?? null;
    if (asserted === null) continue;
    const width = (kw.char_end ?? 0) - (kw.char_start ?? 0);
    const rel = kw.char_start - (r.span?.char_start ?? 0);
    // Two independent readings of how the keyword was WRITTEN, neither of which is
    // `polarity`: the keyword string itself, and the text at the keyword's own offset. The
    // second is needed for the form RFC 1122 and RFC 1123 use constantly - "MUST NOT" as one
    // token the row records as one keyword, so the string alone is not enough, and the first
    // is needed for the form where a positive token is followed by a lower-case `not`.
    let negated = NEGATIVE_FORMS.has(String(primary).toUpperCase());
    if (!negated) {
      if (width > 0 && rel >= 0 && rel + width <= String(r.exact_text ?? "").length) {
        negated = /^\s*not\b/iu.test(String(r.exact_text).slice(rel + width, rel + width + 12));
      } else {
        // No usable offset: fall back to the primary term's own occurrences. Counted,
        // because a fallback that silently took over a quarter of the population would be a
        // different measurement than the one the number claims.
        fellBack += 1;
        negated = new RegExp(`\\b${primary}\\b\\s+not\\b`, "iu").test(text);
      }
    }
    const expected = negated ? "negative" : "positive";
    if (asserted !== expected) {
      disagreements.push({
        rfc: r.rfc,
        section: r.section ?? null,
        term: primary,
        asserted_polarity: asserted,
        expected_polarity: expected,
        why: negated
          ? "a negative keyword quoted with a positive polarity: the row states the opposite of the sentence it quotes"
          : "a positive keyword quoted with a negative polarity",
        text: text.slice(0, 160),
      });
    }
  }
  return {
    rows_checked: checked,
    rows_read_at_their_own_offset: checked - fellBack,
    rows_read_by_fallback_search: fellBack,
    disagreements: disagreements.length,
    agreement_pct: checked === 0 ? null : Math.round((1000 * (checked - disagreements.length)) / checked) / 10,
    vocabulary_out: {
      ...outOfVocabulary,
      why: "MAY NOT and NOT REQUIRED are not in the extractor's NORMATIVE_TERMS. Rows whose polarity turns on them are counted here and judged by nothing: widening the vocabulary is a change to the tool, and a checker that borrows the tool's own decision is not a checker.",
    },
    detail: disagreements.slice(0, 12),
  };
}

// -------------------------------------------------------------------------------------
// R3 - conservation of the budget
// -------------------------------------------------------------------------------------

/**
 * Paging to exhaustion must yield the same set of rows as one call with the ceilings
 * raised. The ceiling is 200 and cannot be raised from here, so the checkable part is the
 * other half: whether paging CHANGES the set a caller receives.
 *
 * Two failure modes are measurable and both are measured per document:
 *
 *   * a whole channel re-shipped on every page. RFC 3261 returns its 357 candidate rows on
 *     page 1 and on page 2, so a caller paging for the requirements list pays for the same
 *     357 rows twice and a caller who concatenates pages gets them twice.
 *   * a channel that truncates without saying so. `mentions` is a bare array: no `total`,
 *     no `returned`, no `truncated` flag, so 500 and "all of them" look identical.
 */
export function budgetConservation(perDocument) {
  const reshipped = perDocument.filter((d) => d.re_shipped_channels.length > 0);
  const silent = perDocument.filter((d) => d.channels_without_a_total.length > 0);
  return {
    documents: perDocument.length,
    documents_re_shipping_a_channel: reshipped.length,
    re_ship_detail: reshipped.slice(0, 12).map((d) => [d.rfc, d.pages, d.re_shipped_channels]),
    documents_with_a_channel_that_does_not_report_its_size: silent.length,
    silent_detail: silent.slice(0, 12).map((d) => [d.rfc, d.channels_without_a_total]),
    not_checked:
      "the equality arm - paged set == unpaged set with the ceiling raised - is not measurable from here, because max_results is capped at 200 by the schema and this harness only reads. Raising the ceiling is a src/ change. What is checked is the half that needs no change: whether paging alters the set a caller receives, and whether a channel that truncates says so.",
  };
}

export { PROSE, NON_PROSE, KEYWORD_BEARING, NEGATIVE_FORMS, MAY_NOT, NOT_REQUIRED };

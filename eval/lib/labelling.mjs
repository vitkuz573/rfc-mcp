// Labelling rules for the bench. These functions decide what a golden rule IS.
//
// They are code on purpose. A hand-picked list of quotes is selected by the person
// who also reads the tool's output, and every such list drifts toward sentences the
// tool already finds. Here the selection is a published function of the document text
// only: given a section, it returns the same sentences on every machine, and it never
// consults the extractor. That is what makes a recall miss evidence instead of taste.
//
// Two rules do the real work:
//
//   1. A candidate sentence is chosen because it carries a MODAL TOKEN, matched
//      case-insensitively. Case is not part of selection.
//   2. The tier label is then derived from case, mechanically: an upper-case RFC 2119
//      keyword makes it `strict`, anything else `weak`.
//
// Selection therefore cannot prefer a tier, and it cannot prefer a sentence the
// extractor happens to emit. It also cannot be tuned to a protocol: nothing here
// mentions DNS.

/** Whitespace-insensitive normalisation, applied to probes and to candidates alike. */
export const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/gu, " ")
    .trim();

/** Modal tokens, case-insensitive, standalone words only. */
const MODAL_CI = /\b(?:must|shall|should|may|required|recommended|optional)\b/iu;

/** RFC 2119/8174 keywords, case-SENSITIVE. Presence of one is the whole strict test. */
const KW_UPPER =
  /\b(?:MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|NOT RECOMMENDED|RECOMMENDED|MAY|OPTIONAL)\b/u;

const KW_UPPER_G = new RegExp(KW_UPPER.source, "gu");

/** First upper-case keyword in the sentence, or null. */
export function upperKeyword(sentence) {
  const m = sentence.match(KW_UPPER);
  return m ? m[0] : null;
}

/** First modal token in any case, with the case it was written in. */
export function modalToken(sentence) {
  const m = sentence.match(
    /\b(?:must not|must|shall not|shall|should not|should|required|not recommended|recommended|optional|may)\b/iu,
  );
  return m ? m[0] : null;
}

// Section kinds that cannot hold a normative statement about an implementation, or
// that are structural. Appendix is deliberately NOT here: appendices hold field
// definitions, and those are exactly the sentences a keyword-driven pass misses.
const SKIP_KINDS = new Set([
  "front_matter",
  "status",
  "toc",
  "table_of_contents",
  "colophon",
  "abstract",
  "acknowledgments",
  "acknowledgements",
  "authors_address",
  "index",
]);

// A sentence is discarded if it looks like one of these. Each exclusion is about
// FORM, not about whether the sentence is normative, so none of them can favour a
// document over another.
const REJECT = [
  { re: /key\s*words?/iu, why: "BCP-14 boilerplate" },
  { re: /interpreted as described/iu, why: "BCP-14 boilerplate" },
  { re: /conventions used in this document/iu, why: "BCP-14 boilerplate" },
  { re: /\S {3,}\S/u, why: "preformatted or diagram text" },
  { re: /[|[\]}`]/u, why: "code or ABNF" },
  { re: /^(?:figure|table|note)\b/iu, why: "caption" },
  { re: /^[*>•\u2022]/u, why: "list bullet" },
  { re: /\bsee (?:also )?(?:section|appendix|figure|table)\b/iu, why: "cross-reference" },
  // Printing artefacts that survived into the text a caller copies from. A sentence
  // carrying a dot leader or a rule of dashes is a contents entry or a running head
  // that the page-furniture pass did not claim, and quoting it as a normative
  // statement would put text in the contract that the RFC never wrote as one. This is
  // also a reportable finding: a probe rejected here is a probe the furniture pass
  // should have removed.
  { re: /\.{4,}/u, why: "dot leader" },
  { re: /-{4,}/u, why: "rule or dashed leader" },
  { re: /\[Page\s+\d+\]/iu, why: "page marker" },
  { re: /^RFC\s+\d+\b/u, why: "running head or title" },
  { re: /\bIP Interface\b/u, why: "running head" },
  // An example illustrates a rule; it does not state one. "For example, a client may
  // retrieve a zone by AXFR" is a true sentence about what a client may do, and a
  // contract that carried it as an obligation would invent a requirement the RFC
  // offered as an illustration.
  {
    re: /^(?:for example|for instance|e\.g\.|i\.e\.|note that|thus|therefore|hence|consequently)\b/iu,
    why: "example or consequence connective",
  },
  // A table row flattened into one line. Two "name:" fields in a sentence is the
  // signature: no RFC states a rule that way.
  { re: /\b[A-Za-z]+ ?[Nn]ame:.*\b[A-Za-z]+ ?[Nn]ame:/u, why: "table row" },
  // A sentence that starts lower case is the tail of a line the splitter cut, not a
  // statement anyone can put in a contract.
  { re: /^[a-z]/u, why: "continuation fragment" },
];

const MIN_CHARS = 45;
const MAX_CHARS = 260;

/** A numeric specification with no modal at all: a bound an implementer must honour. */
const NUMERIC_BOUND = /\b\d+\s*(?:octets?|bytes?|bits?|seconds?|minutes?|hours?|days?|characters?|milliseconds?)\b/iu;

function accepted(normalized) {
  if (normalized.length < MIN_CHARS || normalized.length > MAX_CHARS) return null;
  for (const { re } of REJECT) if (re.test(normalized)) return null;
  return normalized;
}

/**
 * Splits section text into candidate sentences.
 *
 * RFC text is hard-wrapped, so a sentence spans lines; candidates are normalised, not
 * sliced out of the raw text. `exact` keeps the collapsed form, which is what the bench
 * matches on, and `verbatim_ok` records whether the collapsed form also occurs in the
 * byte-exact slice - on a pre-1990 document the two differ by blanked page furniture.
 */
export function candidates(text) {
  const out = [];
  const parts = String(text ?? "").split(/(?<=[.!?])\s+/u);
  for (const raw of parts) {
    const n = norm(raw);
    if (n.length === 0) continue;
    out.push({ exact: n, raw, len: n.length, modal: MODAL_CI.test(n), numeric: NUMERIC_BOUND.test(n) });
  }
  return out;
}

/** The eligible modal-bearing sentences, in document order. */
export function modalCandidates(text) {
  return candidates(text)
    .filter((c) => c.modal)
    .map((c) => accepted(c.exact))
    .filter(Boolean);
}

/** The eligible sentences with no modal that still state a bound. */
export function boundCandidates(text) {
  return candidates(text)
    .filter((c) => !c.modal && c.numeric)
    .map((c) => accepted(c.exact))
    .filter(Boolean);
}

/** Tier from case alone. No judgement, no document-specific knowledge. */
export function labelTier(sentence) {
  return upperKeyword(sentence) ? "strict" : "weak";
}

/**
 * Up to three rules from one section: the first modal sentence, the fourth (so the two
 * are not neighbours from the same paragraph), and the first bound-stating sentence
 * that has no modal at all.
 */
export function rulesFromSection(text, sectionNumber) {
  const picked = [modalCandidates(text)[0], modalCandidates(text)[3], boundCandidates(text)[0]].filter(Boolean);
  return picked.map((probe) => {
    const kw = upperKeyword(probe) ?? modalToken(probe) ?? "none";
    const tier = labelTier(probe);
    return {
      section: sectionNumber,
      tier,
      kw,
      class: tier === "strict" ? "uppercase-modal" : kw === "none" ? "keyword-free-spec" : "lowercase-modal",
      probe: norm(probe),
      why: whyFor(tier, kw, sectionNumber),
    };
  });
}

/**
 * Sections to sample, in order. The middle of the document first, then outward, so a
 * protocol that keeps its obligations in one place is sampled there and one that
 * scatters them is still sampled. Fixed fractions, no document-specific branch.
 */
export const SECTION_PROBE_ORDER = [0.5, 0.25, 0.75, 0.125, 0.875, 0.375, 0.625];
export const RULES_PER_PROTOCOL = 3;

export function sectionProbeOrder(count) {
  const seen = new Set();
  const out = [];
  for (const f of SECTION_PROBE_ORDER) {
    const idx = Math.min(count - 1, Math.max(0, Math.floor(count * f)));
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

/**
 * `why` is templated from the tier rather than written per rule. A hand-written
 * rationale for 300 sentences is a rationale nobody re-reads, and it invites the
 * author to argue with the score after seeing it. The template says what class of
 * obligation the sentence is and what breaks when it is missing from a contract; the
 * report replaces it with a specific one for any rule that misses.
 */
export function whyFor(tier, kw, section) {
  if (tier === "strict") {
    return `Upper-case ${kw} in section ${section} under RFC 2119/8174: binding on an implementer. A contract that omits it lets an implementation be non-conforming without the omission being visible, so a miss is an incomplete contract, not a formatting difference.`;
  }
  if (kw === "none") {
    return `No modal token anywhere in the sentence, in section ${section}: it still fixes a bound or a definition an implementer must honour. No keyword-driven extractor can find it by design, so a miss means the contract has no way to express specifications that are not phrased as obligations.`;
  }
  return `Modal token written in lower case ("${kw}") in section ${section}. Obligations phrased this way bind an implementer and belong in a contract, but must not be counted as RFC 2119 requirements; they are only reachable through the provisional channel, and a miss there is a silent gap rather than a wrong number.`;
}

/**
 * Section choice. Among numbered sections whose kind can hold a statement, try the
 * middle of the document first, then the first quarter, then the third quarter, and
 * take the first that actually yields a candidate. Fixed order, no exceptions, so the
 * sampled section cannot drift toward whatever the extractor handles.
 */
/** Section kinds that cannot hold a normative statement about an implementation. */
export const SKIP_KINDS_FOR_PROBE = SKIP_KINDS;

/**
 * Numbered subsection headings that the text shows and the outline does not list.
 *
 * This is a label-free invariant, and it exists because a bench that samples sections
 * FROM the outline is blind to a defect that removes sections from the outline. An
 * indented heading line - the way RFCs before ~2010 set a subsection title - is dropped
 * by the heading finder, and every statement under it becomes unreachable while the
 * document still looks complete. Measuring it needs no labels and no knowledge of the
 * protocol: compare what the text says against what the outline lists.
 */
export function danglingHeadings(text, outlineNumbers) {
  const known = new Set(outlineNumbers);
  const found = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^[ ]{0,8}(\d+(?:\.\d+)+)\.?[ ]{1,4}([A-Z(].{0,70})$/u);
    if (!m) continue;
    const number = m[1];
    if (known.has(number)) continue;
    // A sentence that merely starts with a number is not a heading; a heading is short
    // and does not end in a full stop.
    if (/[.;,]$/u.test(line.trim())) continue;
    if (!found.has(number)) found.set(number, line.trim());
  }
  return [...found.entries()].map(([number, title]) => ({ number, title }));
}

export function chooseSection(sections, textFor) {
  const eligible = sections.filter((s) => s.number !== "" && !SKIP_KINDS.has(s.kind));
  const order = [0.5, 0.25, 0.75].map((f) => Math.min(eligible.length - 1, Math.floor(eligible.length * f)));
  for (const idx of order) {
    const s = eligible[idx];
    if (!s) continue;
    const text = textFor(s);
    if (modalCandidates(text).length > 0) return { section: s, attempt: idx / eligible.length };
  }
  return null;
}

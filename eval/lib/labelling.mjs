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
//
// `references` and `authors` were added after measurement. The red-team audit counted 8
// probes cut from `references` sections and 2 from `authors`, and the project's own
// miss review had already classified all 8 of the bibliography ones `label_error` - the
// project was counting its own labelling defect in the recall denominator and calling the
// remainder a miss. A bibliography entry is a citation, not an obligation, and an author's
// address is a postal address; neither is in the same category as a `Requirements`
// section, and the fix is to the LABELLER rather than to the denominator, because the
// sentences were never candidates. Appendix stays out of the skip list on purpose.
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
  "authors",
  "references",
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
 * A line that begins with a dotted number and an upper-case word: the shape a typeset
 * subsection title has. Loose on purpose, since an invariant tighter than the heading
 * finder stops seeing what the finder dropped.
 */
const HEADING_SHAPE = /^[ ]{0,8}(\d+(?:\.\d+)+)\.?[ ]{1,4}([A-Z(].{0,70})$/u;

/**
 * A paragraph that opens with a section number and an RFC 2119 keyword is content, not
 * a title: "3.3 MUST be set on every interface" is a sentence a document can write, and
 * no typeset title begins with a keyword. The parser applies this same rule before it
 * promotes an indented line, so a line the parser would never call a heading is a line
 * this invariant must not report either: a false positive here sends the reader looking
 * for a title that was never on the page, and a reader sent there once stops reading
 * the output.
 */
const KEYWORD_LEAD =
  /^(?:MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|SHALL|REQUIRED|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b[\s,]/u;

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Is the line under this one a continuation of the same sentence?
 *
 * A wrapped paragraph is the other half of "a line that merely begins with a number":
 * the line that opens it matches the heading shape and the line under it carries on at
 * the same indent. A title is followed by a blank line or by body that steps in, which
 * is the test the parser applies before it promotes an indented line - so this is the
 * parser's condition inverted, and the invariant has to agree with the parser about
 * what a title is. A sampled section that ends on its own title has no line to judge
 * by, and absence of evidence is not evidence of a continuation.
 */
function continuesAtSameIndent(lines, index) {
  for (let j = index + 1; j < lines.length; j += 1) {
    const next = lines[j];
    if (next.trim() === "") continue;
    return indentOf(next) <= indentOf(lines[index]);
  }
  return false;
}

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
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(HEADING_SHAPE);
    if (!m) continue;
    const number = m[1];
    if (known.has(number)) continue;
    // A bare integer is already outside the shape (a level-1 title sits at column 0 and
    // is in the outline anyway), and so is a lower-case continuation - "1983 must not be
    // read as a section number" has neither a dotted number nor an upper-case first
    // word. A heading is short, ends without a full stop, and does not open with a
    // keyword.
    if (KEYWORD_LEAD.test(m[2])) continue;
    if (/[.;,]$/u.test(line.trim())) continue;
    if (continuesAtSameIndent(lines, i)) continue;
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

// -------------------------------------------------------------------------------------
// Provenance: where in the bytes a probe was cut from.
//
// WHY THIS EXISTS. The golden set recorded a snapshot id per PROTOCOL and nothing at all
// on the 260 rules that are actually scored - no snapshot, no offset, not a byte. A
// golden set that cannot name the bytes it was cut from cannot be re-verified after a
// re-sync, and it could not be: 95 of 95 protocols had drifted, drift was printed, and
// nothing acted on it, so a stale probe was indistinguishable from a tool miss. Ten of the
// old probes were not even reachable any more - RFC 959's G0004 claims section "5", which
// now returns 30 characters, and a 30-character text cannot yield a 154-character probe.
// Every rule now carries the snapshot, the section, and the character offsets in BOTH the
// raw and the normalised view, so a rebuild after a re-sync either reproduces the rule or
// names it.
//
// The mapping is built once per section rather than per probe: `norm` collapses runs of
// whitespace to one space, so an index into the normalised text is not an index into the
// raw text, and the two views have to be walked together to say where a probe came from.
// -------------------------------------------------------------------------------------

/**
 * `normalised` plus, for each of its characters, the index of the raw character it came
 * from. A collapsed whitespace run maps to its first character; leading and trailing
 * whitespace contributes nothing, which is what `norm` does to it.
 */
export function normalisationMap(rawText) {
  const raw = String(rawText ?? "");
  const map = [];
  let chars = "";
  let seen = false;
  let inRun = false;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].trim() === "") {
      if (seen && !inRun) {
        chars += " ";
        map.push(i);
        inRun = true;
      }
      continue;
    }
    chars += raw[i];
    map.push(i);
    seen = true;
    inRun = false;
  }
  return { normalised: chars, map };
}

/**
 * Where `probe` sits in `rawText`, in both views. Null when the probe is not in this text
 * at all, which is the answer a rebuild after a re-sync has to be able to give. When it
 * occurs more than once, the first occurrence is returned and `occurrences` says how many
 * there were: a sentence that repeats inside a section is a real property of the text,
 * and re-verification must not silently pick one of the places.
 */
export function locate(rawText, probe) {
  const { normalised, map } = normalisationMap(rawText);
  const needle = norm(probe);
  if (needle.length === 0 || normalised.length !== map.length) return null;
  const first = normalised.indexOf(needle);
  if (first < 0) return null;
  let occurrences = 0;
  for (let at = first; at >= 0; at = normalised.indexOf(needle, at + 1)) occurrences += 1;
  const last = first + needle.length - 1;
  return {
    norm_start: first,
    norm_end: first + needle.length,
    raw_start: map[first],
    raw_end: (map[last] ?? map[map.length - 1] ?? 0) + 1,
    occurrences,
  };
}

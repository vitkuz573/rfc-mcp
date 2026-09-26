/**
 * RFC 2119 / RFC 8174 normative language extraction.
 *
 * Contract, in order of precedence:
 *  1. only the eleven RFC 2119 keywords are recognized, in upper case, as
 *     required by RFC 8174 §3 ("MUST" only has an effect when it is
 *     capitalized);
 *  2. the longest phrase wins, so "MUST NOT" is never split into "MUST" + "NOT";
 *  3. a keyword inside a quoted definition or inside a non-prose block is
 *     recorded as a mention but never promoted to a requirement;
 *  4. every requirement keeps the exact sentence, the section and block it came
 *     from, a citation id, and an explicit parse status. Nothing is inferred
 *     silently: a missing actor yields `partial`, not a fabricated one.
 */

import type {
  Block,
  NormativeCandidate,
  NormativeCandidateAnalysis,
  NormativeMention,
  Requirement,
  RequirementShape,
  Section,
  Span,
} from "../core/types.js";
import { NORMATIVE_TERMS, type NormativePolarity, type NormativeStrength, type NormativeTerm } from "../core/types.js";
import { citationId, quoteHash } from "./citation.js";

export interface NormativeAnalysis {
  readonly mentions: readonly NormativeMention[];
  readonly requirements: readonly Requirement[];
  readonly coverage: {
    readonly blocks_scanned: number;
    readonly blocks_skipped: number;
    /** Why each skipped block was skipped, as `kind` or `section:<kind>`. */
    readonly blocks_skipped_by_kind: Readonly<Record<string, number>>;
    /**
     * How many of the skipped blocks carry an RFC 2119 keyword.
     *
     * This is the loss made visible. Tables, figures and preformatted text are out of
     * scope by design, and a specification that states its rules in a field table will
     * report a low count; that is a known gap and not an absence, and a caller can only
     * act on the difference if the number is on the response. Corpus-wide it is 278
     * blocks.
     */
    readonly keyword_bearing_blocks_skipped: number;
    readonly sentences_scanned: number;
    readonly mentions_found: number;
    readonly requirements_emitted: number;
  };
  readonly warnings: readonly string[];
}

const TERM_PATTERN = new RegExp(
  `\\b(${Object.keys(NORMATIVE_TERMS)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/ /gu, "\\s+"))
    .join("|")})\\b`,
  "gu",
);

/**
 * The same vocabulary, without the global flag, for a yes/no question.
 *
 * `TERM_PATTERN` carries `g`, and a global regex is stateful: `test()` advances
 * `lastIndex`, and `String.prototype.matchAll` copies `lastIndex` into the clone it
 * walks. So one `TERM_PATTERN.test(...)` anywhere - the loss counter below did exactly
 * that - silently moved the starting point of every later sentence scan in the same
 * process and requirements stopped being found. Two tests in this file passed alone and
 * failed together, which is the only shape this bug has.
 */
const TERM_PROBE = new RegExp(TERM_PATTERN.source, "u");

/** `matchAll` over the global pattern, immune to a `lastIndex` left by an earlier `test()`. */
function matchTerms(text: string): RegExpExecArray[] {
  TERM_PATTERN.lastIndex = 0;
  return [...text.matchAll(TERM_PATTERN)];
}

const QUOTED_TERM = new RegExp(`(["'\`]\\s*\\b(?:${Object.keys(NORMATIVE_TERMS).join("|")})\\s*["'\`])`, "iu");
const META_DISCUSSION =
  /\b(?:not implementing|does not implement|implementing a|keywords? (?:for|in)|the specification says|the effects? on)\b/iu;
/**
 * Sentence boundary: terminal punctuation, then layout whitespace, then something
 * that can open a sentence.
 *
 * The separator class must include newlines. RFC text is hard-wrapped at column 72,
 * so a period at the end of a line very often ends a sentence, and a class of spaces
 * and tabs only never reached it: twenty separate statements on twenty consecutive
 * lines came back as one "sentence". That is not cosmetic. `exact_text` is what a
 * caller reads and judges, and the action-verb test scans the clause it is given — a
 * whole paragraph almost always contains a verb, so the paragraph was classified
 * `demand` whatever it actually said. Excluding newlines inflated that bucket with
 * exactly the entries that should not be in it.
 *
 * A line that does *not* end with terminal punctuation still continues into the next
 * one, which is the ordinary case for a wrapped sentence, so the boundary lands in the
 * right place without a parser.
 */
const SENTENCE_BOUNDARY = /([.!?])(?:[ \t]*\n)+[ \t]*(?=[A-Z0-9"'(\[])|([.!?])([ \t]+)(?=[A-Z0-9"'(\[])/gu;
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "cf",
  "vs",
  "no",
  "sec",
  "fig",
  "ref",
  "app",
  "vol",
  "al",
  "resp",
  "ca",
  "approx",
  "dr",
  "st",
  "inc",
  "ltd",
]);

const DEFINITION_SECTIONS = /^(?:normative|informative references|keywords? for use|.*requirement levels?)$/iu;

/** Block kinds the extractor reads. Mirrors `PROSE_BLOCK_KINDS` for the store. */
export const PROSE_BLOCK_KINDS: ReadonlySet<string> = new Set(["paragraph", "list_item", "unknown"]);
/** Section kinds the extractor skips outright. */
export const SKIPPED_SECTION_KINDS: ReadonlySet<string> = new Set(["authors", "index", "references"]);

/**
 * RFC 2119 keywords in any capitalisation, longest phrase first.
 *
 * Used only to find what the strict upper-case extractor did *not* promote. A hit
 * here is reported as a candidate with the reason it was skipped, never as a
 * requirement: RFC 8174 §3 makes "must" a plain English word.
 */
const CANDIDATE_KEYWORD = new RegExp(
  `\\b(${Object.keys(NORMATIVE_TERMS)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/ /gu, "\\s+"))
    .join("|")})\\b`,
  "giu",
);
const MAX_CANDIDATES = 500;

/**
 * Constructions in which an RFC 2119 word is an ordinary English word, not a modal.
 *
 * A candidate list is a lead list, not a contract, and the difference matters: a
 * caller who treats "194 candidates" as "194 obligations" will implement the wrong
 * thing. Two of the eleven keywords are also everyday vocabulary in exactly the
 * shape RFC prose uses, and the shapes below are the reliable cases:
 *
 *   "the recommended method for mail routing"   recommended as a participle
 *   "an optional part of the DNS"               optional as an adjective
 *   "many may ask"                               may as a plural noun
 *
 * The patterns are anchored to a determiner, a possessive or a quantifier
 * immediately before the keyword, which is what separates these from a real modal
 * ("a server may omit", "servers must retry"). They are deliberately one-sided: a
 * candidate that is not matched here is still reported, marked `role: "unknown"`.
 * Guessing "this must is a noun" without a parser would trade one silent error for
 * another, which is the failure mode this whole pass exists to remove.
 */
const NON_MODAL: readonly { readonly keyword: string; readonly pattern: RegExp }[] = [
  // Participles and adjectives: a determiner or possessive governs the keyword.
  { keyword: "recommended", pattern: /\b(?:the|a|an|this|that|these|those|its|their|our|your|most|best|widely)\s+$/iu },
  { keyword: "optional", pattern: /\b(?:the|a|an|this|that|these|those|its|their|our|your|as\s+an?)\s+$/iu },
  { keyword: "required", pattern: /\b(?:the|a|an|this|that|these|those|its|their|our|your|as\s+an?)\s+$/iu },
  // Plural noun: "many may ask", "few may object", "some may prefer".
  { keyword: "may", pattern: /\b(?:many|few|some|most|all|one|two|three)\s+$/iu },
];

/**
 * The action-verb test, taken from the specification itself.
 *
 * RFC 2119 section 3, restated by RFC 8174 section 3, defines when a keyword has
 * effect at all. Rule 1: "MUST, SHALL, or REQUIRED ... only in a sentence that also
 * contains an action verb". Rule 2: "...only where there is an explicit action to
 * be prohibited". Rule 4: "MAY, OPTIONAL ... only where some action is
 * permissible". So a sentence whose keyword governs a clause with no action verb
 * is not a requirement *by the RFC's own definition* — which is a firmer ground
 * than any judgement about modality.
 *
 * The verb lexicon below is deliberately domain-flavoured rather than general: RFC
 * prose is full of protocol verbs, and a general English list would be both larger
 * and less reliable. A clause that scans as verb-free is reported `description`; a
 * clause that cannot be scanned confidently is `indeterminate` and is never folded
 * into either bucket. The counts are reported so a caller can see how much of the
 * list the lexicon actually decided.
 */
const FINITE_VERBS: ReadonlySet<string> = new Set([
  // Auxiliaries and copulas: these are the ones that make a clause finite.
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "has",
  "have",
  "had",
  "does",
  "did",
  "do",
  "will",
  "would",
  "can",
  "could",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "ought",
  // Protocol and infrastructure vocabulary.
  "accept",
  "add",
  "allow",
  "announce",
  "appear",
  "apply",
  "append",
  "assign",
  "assume",
  "attach",
  "authenticate",
  "base",
  "behave",
  "bind",
  "break",
  "cache",
  "calculate",
  "carry",
  "check",
  "choose",
  "cite",
  "clear",
  "close",
  "compare",
  "compile",
  "compose",
  "compute",
  "conclude",
  "conform",
  "connect",
  "consider",
  "consist",
  "construct",
  "contain",
  "control",
  "convert",
  "create",
  "decode",
  "decrypt",
  "defer",
  "define",
  "delay",
  "delete",
  "deny",
  "derive",
  "describe",
  "designate",
  "detect",
  "differ",
  "discard",
  "discuss",
  "display",
  "do",
  "drop",
  "duplicate",
  "emit",
  "enable",
  "encode",
  "encrypt",
  "enforce",
  "ensure",
  "enter",
  "establish",
  "evaluate",
  "exceed",
  "exchange",
  "exclude",
  "execute",
  "exhibit",
  "exist",
  "expect",
  "expire",
  "extend",
  "fail",
  "fetch",
  "filter",
  "find",
  "follow",
  "forward",
  "gather",
  "generate",
  "give",
  "handle",
  "hold",
  "identify",
  "ignore",
  "implement",
  "imply",
  "include",
  "increase",
  "indicate",
  "infer",
  "inform",
  "inherit",
  "initiate",
  "insert",
  "interpret",
  "introduce",
  "invoke",
  "issue",
  "keep",
  "know",
  "learn",
  "leave",
  "limit",
  "list",
  "listen",
  "load",
  "locate",
  "look",
  "maintain",
  "make",
  "manage",
  "map",
  "mark",
  "match",
  "mean",
  "mention",
  "merge",
  "modify",
  "monitor",
  "move",
  "must",
  "name",
  "need",
  "negotiate",
  "note",
  "notice",
  "observe",
  "obtain",
  "occur",
  "offer",
  "open",
  "operate",
  "order",
  "override",
  "pack",
  "parse",
  "pass",
  "perform",
  "permit",
  "persist",
  "place",
  "point",
  "populate",
  "post",
  "prefer",
  "prepare",
  "present",
  "preserve",
  "prevent",
  "process",
  "produce",
  "promise",
  "propagate",
  "protect",
  "provide",
  "publish",
  "query",
  "queue",
  "read",
  "receive",
  "record",
  "reduce",
  "refer",
  "reflect",
  "refresh",
  "register",
  "reject",
  "relay",
  "release",
  "remain",
  "remember",
  "remove",
  "render",
  "repeat",
  "replace",
  "report",
  "represent",
  "request",
  "require",
  "reset",
  "resolve",
  "respond",
  "restart",
  "restore",
  "restrict",
  "result",
  "retry",
  "return",
  "reuse",
  "reverse",
  "revoke",
  "route",
  "run",
  "sample",
  "schedule",
  "search",
  "see",
  "select",
  "send",
  "separate",
  "serialize",
  "serve",
  "set",
  "show",
  "signal",
  "sign",
  "specify",
  "split",
  "start",
  "state",
  "store",
  "stream",
  "submit",
  "subscribe",
  "substitute",
  "support",
  "suppress",
  "suspend",
  "switch",
  "take",
  "terminate",
  "test",
  "think",
  "throw",
  "trace",
  "track",
  "transfer",
  "transform",
  "translate",
  "treat",
  "trigger",
  "trust",
  "unregister",
  "update",
  "upgrade",
  "use",
  "validate",
  "value",
  "verify",
  "wait",
  "walk",
  "want",
  "warn",
  "write",
  "yield",
]);

/** Regular verb forms derived from a base form in the lexicon. */
const VERB_FORMS: ReadonlySet<string> = (() => {
  const forms = new Set<string>();
  for (const base of FINITE_VERBS) {
    forms.add(base);
    forms.add(`${base}s`);
    if (/(?:s|sh|ch|x|z|o)$/u.test(base)) forms.add(`${base}es`);
    if (/e$/u.test(base)) {
      forms.add(`${base}d`);
      forms.add(`${base.slice(0, -1)}ing`);
    } else if (/[^aeiou]y$/u.test(base)) {
      forms.add(`${base.slice(0, -1)}ied`);
      forms.add(`${base}ing`);
    } else {
      forms.add(`${base}ed`);
      forms.add(`${base}ing`);
    }
  }
  return forms;
})();

export function classifyRequirementShape(clause: string, keyword = ""): RequirementShape {
  const trimmed = clause.trim();
  if (trimmed === "") return "indeterminate";
  if (/:\s*$/u.test(trimmed)) return "list_introducer";
  const words = trimmed.toLowerCase().match(/[A-Za-z']+/gu);
  if (!words || words.length === 0) return "indeterminate";
  // The keyword itself is not the action: "must MUST be set" has no verb, and
  // "a server must send" has one. Everything else in the clause counts, including
  // the first word, because the commonest shape is the verb right after the keyword.
  const skip = new Set(keyword.toLowerCase().split(/\s+/u).filter(Boolean));
  for (const word of words) {
    if (skip.has(word)) continue;
    if (VERB_FORMS.has(word)) return "demand";
  }
  return "description";
}

/**
 * Sentences that say whether the document uses the requirement language at all.
 *
 * A requirement count of 0 has two very different causes, and a document often
 * states which one applies in its own text. RFC 2181 §1 opens with "This memo does
 * not use the oft used expressions MUST, SHOULD, MAY, or their negative forms", so
 * its zero is a disclaimer rather than a gap. RFC 2119 and its successors instead
 * write "The key words MUST and MUST NOT ... are to be interpreted as described in
 * RFC 2119", which means a low count is the surprising outcome and worth flagging.
 *
 * Both are reported as evidence with a citation, not as a verdict: the pattern
 * decides only that the document discusses its own keyword usage, and the reader
 * still decides what that means for the rules they are looking for.
 */
const KEYWORD_DISCLAIMER =
  /\b(?:does not use|do not use|does not employ|avoids? the use of|without (?:using|employing))\b[^.]{0,120}\b(?:MUST|SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/iu;
const KEYWORD_ADOPTION =
  /\bkey\s?words?\b[^.]{0,160}\b(?:are|is)\s+to\s+be\s+interpreted\b[^.]{0,80}\b(?:RFC\s*2119|RFC\s*8174|BCP\s*14)\b/iu;

export interface KeywordUsageNote {
  readonly stance: "disclaims" | "adopts";
  readonly exact_text: string;
  readonly citation_id: string;
  readonly block_id: string;
  readonly span: Pick<Span, "byte_start" | "byte_end" | "char_start" | "char_end" | "line_start" | "line_end">;
}

/**
 * Find the sentences in which a document states its own stance on RFC 2119.
 *
 * Runs over the same blocks as the candidate pass, so it costs nothing extra and
 * needs no re-ingest beyond the version that introduced it.
 */
export function detectKeywordUsage(input: {
  readonly snapshotId: string;
  readonly blocks: readonly Block[];
  readonly limit?: number;
}): KeywordUsageNote[] {
  const notes: KeywordUsageNote[] = [];
  const limit = input.limit ?? 5;
  for (const block of input.blocks) {
    if (notes.length >= limit) break;
    for (const sentence of splitSentences(block.text)) {
      if (notes.length >= limit) break;
      const stance = KEYWORD_DISCLAIMER.test(sentence.text)
        ? "disclaims"
        : KEYWORD_ADOPTION.test(sentence.text)
          ? "adopts"
          : null;
      if (stance === null) continue;
      const charStart = block.char_start + sentence.start;
      notes.push({
        stance,
        exact_text: sentence.text,
        block_id: block.id,
        span: {
          byte_start: byteOffsetFromChar(block, charStart),
          byte_end: byteOffsetFromChar(block, charStart + sentence.text.length),
          char_start: charStart,
          char_end: charStart + sentence.text.length,
          line_start: block.line_start,
          line_end: block.line_end,
        },
        citation_id: citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }),
      });
    }
  }
  return notes;
}

/**
 * Classify a candidate keyword occurrence as modal or not, without a parser.
 *
 * Returns `null` when the shape is not one this heuristic claims to know. A `null`
 * is reported as `unknown`, never folded into either bucket, so the caller can see
 * how much of the list was actually decided and discount the rest accordingly.
 */
export function classifyCandidateRole(
  sentence: string,
  index: number,
  keyword: string,
): "modal" | "non_modal" | "unknown" {
  const before = sentence.slice(Math.max(0, index - 40), index);
  for (const rule of NON_MODAL) {
    if (keyword !== rule.keyword) continue;
    // Positive evidence only. Not matching the noise pattern is not proof of
    // modality, so the decision falls through to the structural test below rather
    // than being forced into this rule's verdict.
    if (rule.pattern.test(before)) return "non_modal";
  }
  // A modal verb stands in a finite clause: something precedes it and something
  // follows it. A keyword with no clause after it inside the sentence is a noun
  // reading, not a rule. Leading punctuation is dropped first, so a sentence-final
  // "may." is not mistaken for a verb phrase.
  const after = sentence
    .slice(index + keyword.length)
    .replace(/^[\s,;:.]+/u, "")
    .trim();
  if (after === "") return "non_modal";
  if (before.trim() === "") return "unknown";
  return "modal";
}

/**
 * Fixed texts the RFC Editor prints around every document, matched in full.
 *
 * Two of them are on the end of nearly every modern RFC and neither says anything
 * about the protocol:
 *
 *   - the status notice, whose only verb is a pointer: "Information about the current
 *     status of this document, any errata, and how to provide feedback on it may be
 *     obtained at http://www.rfc-editor.org/info/rfcNNNN.";
 *   - the BCP-13 legal notice, which requires the *redistributor* to reproduce a
 *     licence: "Code Components extracted from this document must include ... License
 *     text ...".
 *
 * In a 190-item hand-checked sample of the candidate list these two sentences were 55
 * rows - 29% of the list a pre-2119 reader depends on. A candidate list where a third
 * of the rows are the same two sentences is not a compliance list, and no amount of
 * reading the rest of the document compensates for it.
 *
 * The match is on the whole sentence, and both texts are fixed strings the RFC Editor
 * inserts, so this is not a topic filter. It is also counted and reported
 * (`boilerplate_statements_excluded:N`) rather than applied quietly, because a filter
 * nobody can see is indistinguishable from a filter that hides a miss.
 */
const FIXED_BOILERPLATE: readonly RegExp[] = [
  /^Information about the current status of this document, any errata, and how to provide feedback on it may be obtained at\b/u,
  /^Code Components extracted from this document must include (?:Revised|Simplified) BSD License text\b/u,
  /^This document is part of a family of documents defining\b/u,
  /^Code Components extracted from this document must include\b.*Trust Legal Provisions/u,
  // The two other shapes the same legal notice is printed in. Found by measurement
  // rather than by reading RFC 13: a 185-item hand-checked sample of the candidate list
  // still carried 11 rows of them after the patterns above were in place, and they are
  // the same notice with the same lack of anything to do with the protocol.
  /^This document may contain material from IETF Documents or IETF Contributions\b/u,
  /^The person\(s\) controlling the copyright in some of this material may not have granted the IETF Trust\b/u,
];

export function isFixedBoilerplate(sentence: string): boolean {
  const text = sentence.replace(/\s+/gu, " ").trim();
  return FIXED_BOILERPLATE.some((pattern) => pattern.test(text));
}

export function analyzeNormative(input: {
  readonly snapshotId: string;
  readonly rfc: number;
  readonly sections: readonly Section[];
  readonly blocks: readonly Block[];
}): NormativeAnalysis {
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const mentions: NormativeMention[] = [];
  const requirements: Requirement[] = [];
  const warnings: string[] = [];
  let blocksScanned = 0;
  let blocksSkipped = 0;
  let sentencesScanned = 0;
  const blocksSkippedByKind: Record<string, number> = {};
  // The loss counter. Tables and preformatted text are out of scope BY DESIGN, and a
  // design decision that costs statements has to be visible: `blocks_skipped` says how
  // much text was not read, and this says how much of that text carried an RFC 2119
  // keyword. Corpus-wide, 278 non-prose blocks hold an upper-case keyword and none of
  // them is scanned, so a zero count on a specification that states its rules in a field
  // table is a known gap rather than an absence - which is the difference between a
  // caller reading `read` and a caller being misled.
  let keywordBearingBlocksSkipped = 0;

  for (const block of input.blocks) {
    const section = sectionsById.get(block.section_id);
    const sectionKind = section?.kind ?? "unknown";
    const sectionTitle = section?.title ?? "";
    if (!PROSE_BLOCK_KINDS.has(block.kind) || SKIPPED_SECTION_KINDS.has(sectionKind)) {
      blocksSkipped += 1;
      const bucket = SKIPPED_SECTION_KINDS.has(sectionKind) ? `section:${sectionKind}` : block.kind;
      blocksSkippedByKind[bucket] = (blocksSkippedByKind[bucket] ?? 0) + 1;
      if (TERM_PROBE.test(block.text)) keywordBearingBlocksSkipped += 1;
      continue;
    }
    blocksScanned += 1;

    for (const sentence of splitSentences(block.text)) {
      sentencesScanned += 1;
      const matches = matchTerms(sentence.text);
      if (matches.length === 0) continue;

      const distinctTerms = new Set(
        matches.map((match) => normalizeTerm(match[0])).filter((term): term is NormativeTerm => term !== null),
      );
      // A sentence that enumerates several keywords is discourse *about* the
      // requirement language ("the effects of not implementing a MUST or
      // SHOULD..."), not a requirement. It is kept as a mention and flagged.
      const enumerates = distinctTerms.size >= 3 || META_DISCUSSION.test(sentence.text);
      const inDefinition =
        enumerates || QUOTED_TERM.test(sentence.text) || DEFINITION_SECTIONS.test(sectionTitle.trim());
      // Mentions are per keyword occurrence, because that is what a mention is: this
      // many normative terms appear here, at these offsets. Requirements are per
      // statement, and the two passes used to disagree about that.
      const sentenceMentions: NormativeMention[] = [];
      for (const match of matches) {
        const term = normalizeTerm(match[0]);
        if (!term) continue;
        const meta = NORMATIVE_TERMS[term];
        const quoted = isQuoted(sentence.text, match.index ?? 0, term);
        const disposition: NormativeMention["disposition"] =
          quoted || inDefinition ? "definition" : PROSE_BLOCK_KINDS.has(block.kind) ? "requirement" : "context";

        const charStart = block.char_start + sentence.start + (match.index ?? 0);
        const charEnd = charStart + match[0].length;
        const quote = sentence.text;
        const flags: string[] = [];
        if (quoted) flags.push("term_quoted");
        if (enumerates) flags.push("keyword_enumeration");
        if (inDefinition && !quoted && !enumerates) flags.push("definition_section");
        if (matches.length > 1) flags.push("multiple_terms_in_sentence");
        if (sectionKind === "appendix") flags.push("in_appendix");
        if (sectionKind === "front_matter" || sectionKind === "status") flags.push("in_front_matter");
        if (sectionTitle.toLowerCase().includes("requirements notation")) flags.push("requirements_notation_section");
        if (!section) flags.push("section_unresolved");

        const mention: NormativeMention = {
          id: `men_${citationId({
            snapshotId: input.snapshotId,
            blockId: block.id,
            byteStart: charStart,
            quote: match[0],
          }).slice(4, 20)}`,
          snapshot_id: input.snapshotId,
          rfc: input.rfc,
          section_id: block.section_id,
          block_id: block.id,
          term,
          strength: meta.strength,
          polarity: meta.polarity,
          exact_text: quote,
          span: {
            byte_start: byteOffsetFromChar(block, charStart),
            byte_end: byteOffsetFromChar(block, charEnd),
            char_start: charStart,
            char_end: charEnd,
            codepoint_start:
              block.codepoint_start + codePointCount(block.text.slice(0, sentence.start + (match.index ?? 0))),
            codepoint_end:
              block.codepoint_start +
              codePointCount(block.text.slice(0, sentence.start + (match.index ?? 0) + match[0].length)),
            line_start: block.line_start,
            line_end: block.line_end,
          },
          context: contextAround(sentence.text, match.index ?? 0, match[0].length, 160),
          disposition,
          flags,
          citation_id: citationId({
            snapshotId: input.snapshotId,
            blockId: block.id,
            byteStart: charStart,
            quote,
          }),
        };
        mentions.push(mention);
        sentenceMentions.push(mention);
      }

      // One requirement per STATEMENT. The candidate extractor was fixed to that in an
      // earlier round and this one was not, so "EMTU_R MUST be greater than or equal to
      // 576, SHOULD be either configurable or indefinite, and SHOULD be greater than or
      // equal to the MTU of the connection" came back three times and
      // `coverage.total_requirements` - a number callers trust - counted one sentence as
      // three requirements. 1 411 of 11 640 strict rows corpus-wide, in 96 of 119
      // documents, were a repeat of a sentence already in the same list.
      //
      // A sentence that is discourse ABOUT the requirement language stays a mention. That
      // decision was already made above, in `inDefinition`, and it is not the collapse
      // that gets to override it: "the effects of not implementing a MUST or SHOULD may
      // be subtle" carries two keywords and is still not an obligation.
      if (inDefinition) continue;
      const primary = sentenceMentions.find((m) => !m.flags.includes("term_quoted"));
      if (!primary) continue;
      const primaryIndex = matches.find((m) => m[0] === primary.term)?.index ?? 0;
      const primaryTerm = primary.term;
      const primaryMeta = NORMATIVE_TERMS[primaryTerm];
      const requirementFlagsPending: string[] = [];
      const beforeKeyword = sentence.text.slice(0, primaryIndex);
      const clause = parseClause(sentence.text, primaryIndex, primary.term.length);
      // A list marker is an artefact of the publication format, not part of the
      // requirement. It is stripped from the clause and reported here, so the cleanup is
      // visible instead of silently changing what the actor says.
      if (LIST_MARKER.test(beforeKeyword)) {
        requirementFlagsPending.push("list_marker_stripped_from_clause");
      }
      if (/\bexcept that\b/iu.test(sentence.text.slice(0, primaryIndex + 200))) {
        requirementFlagsPending.push("exception_before_keyword");
      }
      const hasActor = clause.actor !== null;
      const hasAction = clause.action !== null;
      const parseStatus: Requirement["parse_status"] = hasActor && hasAction ? "complete" : "partial";
      const requirementFlags = [...primary.flags, ...requirementFlagsPending];
      if (matches.length > 1) requirementFlags.push("keywords_collapsed_to_one_row");
      if (!hasActor) requirementFlags.push("actor_not_explicit");
      if (!hasAction) requirementFlags.push("action_not_explicit");
      if (sectionTitle.toLowerCase().includes("requirements notation")) {
        requirementFlags.push("requirements_notation_section");
      }
      const sentenceCharStart = block.char_start + sentence.start;
      const sentenceCharEnd = sentenceCharStart + sentence.text.length;
      requirements.push({
        ...primary,
        id: `req_${citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: sentenceCharStart,
          quote: sentence.text,
        }).slice(4, 20)}`,
        term: primaryTerm,
        strength: primaryMeta.strength,
        polarity: primaryMeta.polarity,
        keywords: sentenceMentions.map((m) => ({
          term: m.term,
          strength: m.strength,
          polarity: m.polarity,
          char_start: m.span.char_start,
          char_end: m.span.char_end,
        })),
        // The span is the STATEMENT, not one keyword inside it. A caller anchoring a
        // contract line to this row quotes the sentence, so the citation has to verify
        // the sentence; a span that covered four letters of it verified nothing about
        // what the contract would say.
        span: {
          byte_start: byteOffsetFromChar(block, sentenceCharStart),
          byte_end: byteOffsetFromChar(block, sentenceCharEnd),
          char_start: sentenceCharStart,
          char_end: sentenceCharEnd,
          codepoint_start: block.codepoint_start + codePointCount(block.text.slice(0, sentence.start)),
          codepoint_end:
            block.codepoint_start + codePointCount(block.text.slice(0, sentence.start + sentence.text.length)),
          line_start: block.line_start,
          line_end: block.line_end,
        },
        context: contextAround(sentence.text, primaryIndex, primary.term.length, 160),
        disposition: "requirement",
        clause,
        parse_status: parseStatus,
        confidence: parseStatus === "complete" ? 0.9 : 0.7,
        flags: requirementFlags,
        citation_id: citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: sentenceCharStart,
          quote: sentence.text,
        }),
      });
    }
  }

  if (blocksScanned === 0) warnings.push("no_prose_blocks_scanned");
  if (keywordBearingBlocksSkipped > 0) {
    warnings.push(
      `normative_text_in_unscanned_blocks:${keywordBearingBlocksSkipped}:these_blocks_carry_an_rfc2119_keyword_and_are_out_of_scope_by_design:read_the_section`,
    );
  }

  return {
    mentions,
    requirements,
    coverage: {
      blocks_scanned: blocksScanned,
      blocks_skipped: blocksSkipped,
      blocks_skipped_by_kind: blocksSkippedByKind,
      keyword_bearing_blocks_skipped: keywordBearingBlocksSkipped,
      sentences_scanned: sentencesScanned,
      mentions_found: mentions.length,
      requirements_emitted: requirements.length,
    },
    warnings,
  };
}

/**
 * Requirement-shaped statements the strict extractor left out.
 *
 * The strict reading is correct and stays authoritative: RFC 8174 §3 gives an
 * uncapitalised keyword no normative force, so promoting these would be wrong.
 * The problem this solves is the opposite one. A count of 0 requirements cannot
 * distinguish "this RFC states no requirements" from "this RFC states its
 * requirements in a form the extractor does not recognise" — RFC 1035 writes
 * "Z  Reserved for future use.  Must be zero in all queries and responses." in a
 * field-definition block, and RFC 4033 uses a lower-case "must" throughout. Both
 * are binding on an implementer. Reporting them as candidates, with the reason
 * each was skipped, is what makes a zero count interpretable.
 */
export function analyzeNormativeCandidates(input: {
  snapshotId: string;
  rfc: number;
  sections: readonly Section[];
  blocks: readonly Block[];
  limit?: number;
}): NormativeCandidateAnalysis {
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const candidates: NormativeCandidate[] = [];
  const byKeyword: Record<string, number> = {};
  const byCase: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const byShape: Record<string, number> = {};
  const warnings: string[] = [];
  const limit = input.limit ?? MAX_CANDIDATES;
  let scanned = 0;
  let unreadable = 0;
  let truncated = false;
  let skippedSections = 0;
  let skippedReferenceBlocks = 0;
  let boilerplateExcluded = 0;
  let fragments = 0;
  let previousEndedOpen = false;

  for (const block of input.blocks) {
    const section = sectionsById.get(block.section_id);
    const sectionKind = section?.kind ?? "unknown";
    // The candidate pass is a wider net than the strict one — it deliberately adds
    // tables and preformatted text — but it must not be reading a different document.
    // A bibliography entry ("[RFC-1010] J. Reynolds, and J. Postel, ...") contains
    // the word "should" inside a citation and is not a requirement-shaped statement
    // at all, and the authors' address section is not normative prose. Both are
    // excluded here for the reason the strict extractor excludes them, and the count
    // is reported rather than assumed.
    if (SKIPPED_SECTION_KINDS.has(sectionKind)) {
      skippedSections += 1;
      continue;
    }
    if (block.kind === "reference_entry") {
      skippedReferenceBlocks += 1;
      continue;
    }
    const sectionTitle = section?.title ?? "";
    const inDefinitionSection = DEFINITION_SECTIONS.test(sectionTitle.trim());
    const isProse = PROSE_BLOCK_KINDS.has(block.kind);
    scanned += 1;
    if (block.text.includes("\uFFFD")) unreadable += 1;

    // A page break splits a sentence across two blocks, and the second half opens
    // mid-clause. The text is verbatim and correct; it is simply not a whole
    // statement, and saying so beats handing a caller "in this memo, and may be
    // datagrams." as though the RFC had said that. The offset of the block's first
    // non-space character is where an opening sentence starts, indentation aside.
    const firstContent = block.text.length - block.text.trimStart().length;
    const continuesPrevious = previousEndedOpen && /^\s*[a-z]/u.test(block.text);

    for (const sentence of splitSentences(block.text)) {
      if (candidates.length >= limit) {
        truncated = true;
        break;
      }
      if (isFixedBoilerplate(sentence.text)) {
        boilerplateExcluded += 1;
        continue;
      }
      const keywordMatches = [...sentence.text.matchAll(CANDIDATE_KEYWORD)];
      if (keywordMatches.length === 0) continue;
      const reason: NormativeCandidate["reason"] = !isProse
        ? "non_prose_block"
        : inDefinitionSection
          ? "definition_section"
          : null;

      // One row per statement, not per keyword occurrence. The action-verb test reads
      // the clause that follows the keyword, so a sentence holding two keywords used
      // to be emitted twice and could be filed under two different shapes at once.
      const classified = keywordMatches
        .map((match) => {
          const raw = match[0];
          const keyword = raw.replace(/\s+/gu, " ").toLowerCase();
          const keywordCase: NormativeCandidate["keyword_case"] =
            raw === raw.toLowerCase()
              ? "lower"
              : raw === raw.toUpperCase()
                ? "upper"
                : raw === raw[0]!.toUpperCase() + raw.slice(1).toLowerCase()
                  ? "title"
                  : "upper";
          // The clause the keyword governs: from just after the keyword to the end of
          // the sentence, or to a semicolon, which is where RFC prose starts a new
          // independent clause.
          const governed = sentence.text
            .slice((match.index ?? 0) + raw.length)
            .split(/;/u)[0]!
            .trim();
          return {
            keyword: raw,
            normalised: keyword,
            keyword_case: keywordCase,
            role: classifyCandidateRole(sentence.text, match.index ?? 0, keyword),
            shape: classifyRequirementShape(governed, keyword),
            char_start: block.char_start + sentence.start + (match.index ?? 0),
            length: raw.length,
          };
        })
        // The strict extractor already owns every upper-case keyword in a prose block
        // outside a definition section; re-reporting it would be noise.
        .filter((entry) => entry.keyword_case !== "upper" || reason !== null);
      if (classified.length === 0) continue;

      const lead = classified[0]!;
      const charStart = lead.char_start;
      const charEnd = charStart + lead.length;
      const isFragment = continuesPrevious && sentence.start === firstContent;
      candidates.push({
        id: `cnd_${citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }).slice(4, 20)}`,
        snapshot_id: input.snapshotId,
        rfc: input.rfc,
        section_id: block.section_id,
        block_id: block.id,
        keywords: classified.map(({ keyword, keyword_case, role, shape, char_start, length }) => ({
          keyword,
          keyword_case,
          role,
          shape,
          char_start,
          length,
        })),
        keyword: lead.keyword,
        keyword_case: lead.keyword_case,
        role: lead.role,
        shape: lead.shape,
        reason,
        continues_previous_block: isFragment,
        char_start: charStart,
        exact_text: sentence.text,
        context: contextAround(sentence.text, keywordMatches[0]?.index ?? 0, lead.length, 160),
        span: {
          byte_start: byteOffsetFromChar(block, charStart),
          byte_end: byteOffsetFromChar(block, charEnd),
          char_start: charStart,
          char_end: charEnd,
          line_start: block.line_start,
          line_end: block.line_end,
        },
        citation_id: citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }),
      });
      if (isFragment) fragments += 1;
      // The per-statement buckets count statements, which is what a caller filters on.
      // The per-keyword buckets keep counting occurrences, under separate names.
      byShape[lead.shape] = (byShape[lead.shape] ?? 0) + 1;
      byRole[lead.role] = (byRole[lead.role] ?? 0) + 1;
      byCase[lead.keyword_case] = (byCase[lead.keyword_case] ?? 0) + 1;
      for (const entry of classified) {
        byKeyword[entry.normalised] = (byKeyword[entry.normalised] ?? 0) + 1;
      }
      if (reason !== null) byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    previousEndedOpen = !/[.!?][")'\]”’]*\s*$/u.test(block.text.trimEnd());
    if (truncated) break;
  }

  if (truncated) warnings.push(`candidates_truncated_at_${limit}`);
  if (unreadable > 0) warnings.push(`blocks_with_replacement_characters:${unreadable}`);
  if (scanned === 0) warnings.push("no_blocks_scanned_for_candidates");
  if (skippedSections > 0) warnings.push(`candidate_sections_skipped:${skippedSections}`);
  if (skippedReferenceBlocks > 0) warnings.push(`reference_entry_blocks_skipped:${skippedReferenceBlocks}`);
  if (boilerplateExcluded > 0) warnings.push(`boilerplate_statements_excluded:${boilerplateExcluded}`);
  if (fragments > 0) {
    warnings.push(
      `sentences_split_across_a_page_break:${fragments}:flagged_continues_previous_block_not_whole_statements`,
    );
  }

  return {
    candidates,
    by_keyword: byKeyword,
    by_case: byCase,
    by_reason: byReason,
    by_role: byRole,
    by_shape: byShape,
    unreadable_blocks: unreadable,
    scanned_blocks: scanned,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */

interface Sentence {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  SENTENCE_BOUNDARY.lastIndex = 0;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BOUNDARY.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    const candidate = text.slice(start, boundary);
    if (!endsWithAbbreviation(candidate)) {
      pushSentence(out, text, start, boundary);
      start = boundary;
    }
  }
  pushSentence(out, text, start, text.length);
  return out;
}

/**
 * A sentence that ends a hard-wrapped line but continues in the next one.
 *
 * A wrapped sentence is one sentence and must quote as one, so the newline is kept
 * inside it; a caller reading `exact_text` wants the whole statement, not the first
 * 72 columns of it. This is the case the strict extractor also relies on: RFC prose
 * states a requirement across several lines, and splitting there would quote half of
 * it.
 */
export function continuesAcrossLineBreak(text: string): boolean {
  return /[.!?]["')\]”’]?[ \t]*\n[ \t]*[a-z]/u.test(text);
}

function pushSentence(out: Sentence[], text: string, start: number, end: number): void {
  let from = start;
  let to = end;
  while (from < to && /\s/u.test(text[from]!)) from += 1;
  while (to > from && /\s/u.test(text[to - 1]!)) to -= 1;
  if (to > from) out.push({ text: text.slice(from, to), start: from, end: to });
}

function endsWithAbbreviation(fragment: string): boolean {
  const match = /([A-Za-z.]+)\.$/u.exec(fragment.trimEnd());
  if (!match) return false;
  const token = match[1]!.toLowerCase().replace(/\.$/u, "");
  if (token.length === 1) return true;
  return ABBREVIATIONS.has(token);
}

function normalizeTerm(raw: string): NormativeTerm | null {
  const key = raw.replace(/\s+/gu, " ");
  if (key in NORMATIVE_TERMS) return key as NormativeTerm;
  return null;
}

function isQuoted(text: string, index: number, term: string): boolean {
  const before = text.slice(Math.max(0, index - 2), index);
  const after = text.slice(index + term.length, index + term.length + 2);
  return (/["'`]/.test(before) && /["'`]/.test(after)) || /["'`]/.test(before) || /["'`]/.test(after);
}

function byteOffsetFromChar(block: Block, absoluteChar: number): number {
  const relative = Math.max(0, Math.min(block.text.length, absoluteChar - block.char_start));
  return block.byte_start + Buffer.byteLength(block.text.slice(0, relative), "utf8");
}

function codePointCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function contextAround(text: string, index: number, length: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return text.slice(start, end).replace(/\s+/gu, " ");
}

const CONDITION_PATTERN =
  /^(?:if|when|whenever|where|while|unless|except(?:\s+for)?|after|before|in\s+case\s+of|for)\b/iu;
const PRE_KEYWORD_EXCEPTION = /\b(?:except that|except|unless other than|unless|other than)\b/giu;

/**
 * RFC 2822 list markers, and the indentation that follows one.
 *
 * A block's text is the verbatim publication line, so a list item arrives as
 * `o  The RRSIG RR ...` with the marker still attached. Left in place, the marker
 * becomes part of the actor ("o  The RRSIG RR and the RRset"), which is not a
 * sentence the RFC ever says and not a phrase an implementer can act on. The
 * marker is stripped from the parsed clause only; `exact_text` and the stored
 * offsets still point at the original bytes, so nothing becomes unverifiable.
 */
const LIST_MARKER = /^(?:[-*+•‣·o]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/u;

function parseClause(text: string, termIndex: number, termLength: number): Requirement["clause"] {
  const before = text.slice(0, termIndex);
  const after = text.slice(termIndex + termLength);

  let condition: string | null = null;
  let remainder = stripListMarker(before.trimEnd());
  const conditionMatch = CONDITION_PATTERN.exec(remainder);
  if (conditionMatch) {
    const rest = remainder.slice(conditionMatch[0].length);
    const comma = indexOfClauseSeparator(rest);
    if (comma !== -1) {
      condition = `${conditionMatch[0]}${rest.slice(0, comma)}`.trim();
      remainder = rest.slice(comma + 1);
    }
  }

  // A main clause can carry the real subject in its exception tail:
  //   "The HEAD method is identical to GET except that the server MUST NOT …"
  // The actor is the phrase after the last pre-keyword exception marker; the
  // leading part is kept as context instead of being mistaken for the actor.
  let actorSource = remainder;
  let preException: string | null = null;
  const markers = [...remainder.matchAll(PRE_KEYWORD_EXCEPTION)];
  const lastMarker = markers[markers.length - 1];
  if (lastMarker?.index !== undefined) {
    preException = remainder.slice(0, lastMarker.index).trim() || null;
    actorSource = remainder.slice(lastMarker.index + lastMarker[0].length);
  }

  const actorMatch = /(?:^|[.;:!?]\s+|,\s+|\s+)([A-Za-z0-9][\w .()'/-]{0,80}?)\s*$/u.exec(actorSource);
  const actor = cleanClauseText(actorMatch?.[1]) ?? null;
  if (preException && condition === null) condition = preException;

  let action = after.trim() || null;
  let exception: string | null = null;
  const exceptionMatch = /\s+((?:except|unless|other than|but not|aside from)\b.*)$/iu.exec(after);
  if (exceptionMatch && exceptionMatch.index !== undefined) {
    exception = cleanClauseText(exceptionMatch[1]!);
    action = after.slice(0, exceptionMatch.index).trim() || null;
  }
  if (action) {
    action = cleanClauseText(action.replace(/[;:,]$/u, ""));
  }
  return {
    actor,
    condition,
    action,
    exception,
  };
}

/** Remove a leading list marker, if the text still carries one. */
function stripListMarker(text: string): string {
  const stripped = text.replace(LIST_MARKER, "").trimStart();
  return stripped.length > 0 ? stripped : text.trimStart();
}

/**
 * Collapse the layout whitespace of a publication line into single spaces.
 *
 * RFC text is hard-wrapped at column 72 and list items are indented, so a clause
 * lifted verbatim out of a block arrives as "o  The RRSIG RR and the RRset" or
 * "A server\n  that sends a 100 (Continue) response". Neither is quotable as the
 * requirement it states.
 */
function cleanClauseText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = stripListMarker(value.replace(/\s+/gu, " ").trim());
  return cleaned.length > 0 ? cleaned : null;
}

function indexOfClauseSeparator(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if ((char === "," || char === ";") && depth === 0) return i;
  }
  return -1;
}

export function strengthOf(term: NormativeTerm): NormativeStrength {
  return NORMATIVE_TERMS[term].strength;
}

export function polarityOf(term: NormativeTerm): NormativePolarity {
  return NORMATIVE_TERMS[term].polarity;
}

export { quoteHash };

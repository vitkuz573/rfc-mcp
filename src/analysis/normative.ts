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
  Section,
} from "../core/types.js";
import { NORMATIVE_TERMS, type NormativePolarity, type NormativeStrength, type NormativeTerm } from "../core/types.js";
import { citationId, quoteHash } from "./citation.js";

export interface NormativeAnalysis {
  readonly mentions: readonly NormativeMention[];
  readonly requirements: readonly Requirement[];
  readonly coverage: {
    readonly blocks_scanned: number;
    readonly blocks_skipped: number;
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

const QUOTED_TERM = new RegExp(`(["'\`]\\s*\\b(?:${Object.keys(NORMATIVE_TERMS).join("|")})\\s*["'\`])`, "iu");
const META_DISCUSSION =
  /\b(?:not implementing|does not implement|implementing a|keywords? (?:for|in)|the specification says|the effects? on)\b/iu;
const SENTENCE_BOUNDARY = /([.!?])([ \t]+)(?=[A-Z0-9"'(\[])/gu;
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

  for (const block of input.blocks) {
    const section = sectionsById.get(block.section_id);
    const sectionKind = section?.kind ?? "unknown";
    const sectionTitle = section?.title ?? "";
    if (!PROSE_BLOCK_KINDS.has(block.kind) || SKIPPED_SECTION_KINDS.has(sectionKind)) {
      blocksSkipped += 1;
      continue;
    }
    blocksScanned += 1;

    for (const sentence of splitSentences(block.text)) {
      sentencesScanned += 1;
      const matches = [...sentence.text.matchAll(TERM_PATTERN)];
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

        if (disposition === "requirement") {
          const requirementFlagsPending: string[] = [];
          const beforeKeyword = sentence.text.slice(0, match.index ?? 0);
          const clause = parseClause(sentence.text, match.index ?? 0, match[0].length);
          // A list marker is an artefact of the publication format, not part of the
          // requirement. It is stripped from the clause and reported here, so the
          // cleanup is visible instead of silently changing what the actor says.
          if (LIST_MARKER.test(beforeKeyword)) {
            requirementFlagsPending.push("list_marker_stripped_from_clause");
          }
          if (/\bexcept that\b/iu.test(sentence.text.slice(0, (match.index ?? 0) + 200))) {
            requirementFlagsPending.push("exception_before_keyword");
          }
          const hasActor = clause.actor !== null;
          const hasAction = clause.action !== null;
          const parseStatus: Requirement["parse_status"] = hasActor && hasAction ? "complete" : "partial";
          const requirementFlags = [...flags, ...requirementFlagsPending];
          if (!hasActor) requirementFlags.push("actor_not_explicit");
          if (!hasAction) requirementFlags.push("action_not_explicit");
          if (sectionTitle.toLowerCase().includes("requirements notation")) {
            requirementFlags.push("requirements_notation_section");
          }
          requirements.push({
            ...mention,
            disposition: "requirement",
            clause,
            parse_status: parseStatus,
            confidence: parseStatus === "complete" ? 0.9 : 0.7,
            flags: requirementFlags,
          });
        }
      }
    }
  }

  if (blocksScanned === 0) warnings.push("no_prose_blocks_scanned");

  return {
    mentions,
    requirements,
    coverage: {
      blocks_scanned: blocksScanned,
      blocks_skipped: blocksSkipped,
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
  readonly snapshotId: string;
  readonly rfc: number;
  readonly sections: readonly Section[];
  readonly blocks: readonly Block[];
  readonly limit?: number;
}): NormativeCandidateAnalysis {
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const candidates: NormativeCandidate[] = [];
  const byKeyword: Record<string, number> = {};
  const byCase: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const warnings: string[] = [];
  const limit = input.limit ?? MAX_CANDIDATES;
  let scanned = 0;
  let unreadable = 0;
  let truncated = false;

  for (const block of input.blocks) {
    const section = sectionsById.get(block.section_id);
    const sectionTitle = section?.title ?? "";
    const inDefinitionSection = DEFINITION_SECTIONS.test(sectionTitle.trim());
    const isProse = PROSE_BLOCK_KINDS.has(block.kind);
    scanned += 1;
    if (block.text.includes("\uFFFD")) unreadable += 1;

    for (const sentence of splitSentences(block.text)) {
      if (candidates.length >= limit) {
        truncated = true;
        break;
      }
      for (const match of sentence.text.matchAll(CANDIDATE_KEYWORD)) {
        // A candidate is one keyword occurrence, not one sentence, so the cap has to
        // be re-checked here too: a single long sentence would otherwise overshoot it.
        if (candidates.length >= limit) {
          truncated = true;
          break;
        }
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
        const role = classifyCandidateRole(sentence.text, match.index ?? 0, keyword);
        const reason: NormativeCandidate["reason"] = !isProse
          ? "non_prose_block"
          : inDefinitionSection
            ? "definition_section"
            : null;
        // The strict extractor already owns every upper-case keyword in a prose block
        // outside a definition section; re-reporting it would be noise.
        if (keywordCase === "upper" && reason === null) continue;
        const charStart = block.char_start + sentence.start + (match.index ?? 0);
        const charEnd = charStart + raw.length;
        const id = `cnd_${citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }).slice(4, 20)}`;
        candidates.push({
          id,
          snapshot_id: input.snapshotId,
          rfc: input.rfc,
          section_id: block.section_id,
          block_id: block.id,
          keyword: raw,
          keyword_case: keywordCase,
          role,
          reason,
          exact_text: sentence.text,
          context: contextAround(sentence.text, match.index ?? 0, raw.length, 160),
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
        byKeyword[keyword] = (byKeyword[keyword] ?? 0) + 1;
        byCase[keywordCase] = (byCase[keywordCase] ?? 0) + 1;
        byRole[role] = (byRole[role] ?? 0) + 1;
        if (reason !== null) byReason[reason] = (byReason[reason] ?? 0) + 1;
      }
    }
    if (truncated) break;
  }

  if (truncated) warnings.push(`candidates_truncated_at_${limit}`);
  if (unreadable > 0) warnings.push(`blocks_with_replacement_characters:${unreadable}`);
  if (scanned === 0) warnings.push("no_blocks_scanned_for_candidates");

  return {
    candidates,
    by_keyword: byKeyword,
    by_case: byCase,
    by_reason: byReason,
    by_role: byRole,
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

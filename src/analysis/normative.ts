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

import type { Block, NormativeMention, Requirement, Section } from "../core/types.js";
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

const PROSE_BLOCK_KINDS = new Set(["paragraph", "list_item", "unknown"]);
const SKIPPED_SECTION_KINDS = new Set(["authors", "index", "references"]);
const DEFINITION_SECTIONS = /^(?:normative|informative references|keywords? for use|.*requirement levels?)$/iu;

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
          const clause = parseClause(sentence.text, match.index ?? 0, match[0].length);
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

function parseClause(text: string, termIndex: number, termLength: number): Requirement["clause"] {
  const before = text.slice(0, termIndex);
  const after = text.slice(termIndex + termLength);

  let condition: string | null = null;
  let remainder = before.trimEnd();
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
  const actor = actorMatch?.[1]?.trim() ?? null;
  if (preException && condition === null) condition = preException;

  let action = after.trim() || null;
  let exception: string | null = null;
  const exceptionMatch = /\s+((?:except|unless|other than|but not|aside from)\b.*)$/iu.exec(after);
  if (exceptionMatch && exceptionMatch.index !== undefined) {
    exception = exceptionMatch[1]!.trim();
    action = after.slice(0, exceptionMatch.index).trim() || null;
  }
  if (action) {
    action =
      action
        .replace(/\s+/gu, " ")
        .replace(/[;:,]$/u, "")
        .trim() || null;
  }
  return {
    actor: actor && actor.length > 0 ? actor : null,
    condition,
    action,
    exception,
  };
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

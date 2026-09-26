/**
 * Parser for the RFC Editor plain-text publication version (RFC 9920 §5).
 *
 * The text format is line oriented: body text is indented, headings start in
 * column 1, page furniture is bracketed, and the table of contents mirrors the
 * section tree. The parser never rewrites the source: every section and block
 * keeps exact char/byte/code-point offsets into the raw file, so any excerpt
 * can be reproduced and verified byte-for-byte.
 *
 * Known ambiguities are reported as warnings instead of being silently
 * "repaired": a few very old RFCs (RFC 2119 is the canonical example) use
 * column-1 numbered items that are content, not sections. Those items are kept
 * as `list_item` blocks so their text, citations and normative mentions remain
 * exact, and the document is marked `degraded`.
 */

import type { Block, BlockKind, ParseQuality, Section, SectionKind, Span } from "../core/types.js";
import { mapCharOffsets, sha256Hex, shortHash } from "../core/util.js";

export interface ParseInput {
  readonly rfc: number;
  readonly snapshotId: string;
  readonly raw: Buffer;
  readonly parserVersion: string;
}

export interface ParsedDocument {
  readonly sections: readonly Section[];
  readonly blocks: readonly Block[];
  readonly quality: ParseQuality;
  readonly warnings: readonly string[];
  readonly textLength: number;
}

interface Line {
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly value: string;
  /**
   * Set on the zero-width stand-in left behind by a dropped page-furniture line.
   * It is geometrically identical to an empty source line, so the distinction has to
   * be carried explicitly for the section text to be able to report which of its
   * lines were printing artefacts.
   */
  readonly furniture?: true;
}

interface TocInfo {
  readonly startLine: number;
  readonly endLine: number;
  readonly numbers: ReadonlySet<string>;
}

interface Heading {
  readonly line: Line;
  readonly number: string;
  readonly title: string;
  readonly kind: SectionKind;
}

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(\S.*)$/u;
const APPENDIX_HEADING = /^Appendix\s+([A-Z](?:\.\d+)*)\.?\s*(\S.*)?$/u;
const UNNUMBERED_HEADING =
  /^(Abstract|Status of (?:This|These) Memo|Copyright Notice|Notice of TBD|Errata|Acknowledg(?:e)?ments?|Authors?'?s? Address(?:es)?|Contributors|Index|References|Normative References|Informative References|Change Log|Intellectual Property|Full Copyright Statement|Preface)$/iu;

/**
 * Lines that carry no content and exist only because the document was printed.
 *
 * Two shapes occur in the corpus, from two publication eras. Modern RFCs mark the
 * break explicitly with a form feed or a bare `[Page 26]`. RFCs published before the
 * RFC Editor regenerated them in the current plain-text format carry a running head
 * and a running foot instead:
 *
 *     Mockapetris                                     [Page 26]
 *     RFC 1035        Domain Implementation and Specification   November 1987
 *
 * The anchored patterns match only the first shape, so on an old RFC the header
 * field table came back interleaved with its own page furniture. That is not
 * cosmetic: this text is what a caller quotes, and a quote of the RFC 1035 message
 * format that reads `Mockapetris [Page 26]` in the middle of it cannot be checked
 * against the specification by hand.
 *
 * Every pattern is deliberately narrow. A line that merely mentions a page number,
 * or cites `RFC 1035`, is body text and must survive. The running foot is pinned by
 * requiring a month and a four-digit year as the final two fields, the one shape no
 * protocol sentence has.
 */
const PAGE_FURNITURE: readonly RegExp[] = [
  /^\[Page\s+\d+\]$/u,
  /^\[RFC\d+[^\]]*\]$/iu,
  /^\[Email\]$/u,
  /^\[Note\]$/u,
  /^\*Note\*$/u,
  // Running head: a running author or title, padded, closed by the page marker.
  /^.{0,72}\[\s*Page\s+\d+\s*\]$/u,
  // Running foot: `RFC <n>`, the document title, then the publication month and year.
  /^RFC\s+\d{1,5}\s{2,}\S.*\s{2,}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s*$/u,
];

const KEYWORD_LEAD =
  /^(?:MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|SHALL|REQUIRED|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b[\s,]/u;
const MAX_HEADING_CHARS = 200;
const MAX_HEADING_WORDS = 20;
const FRONT_MATTER_ORDINAL = 0;

export function parseRfcText(input: ParseInput): ParsedDocument {
  const warnings: string[] = [];
  let rejectedColumnOneItems = 0;
  // `ignoreBOM: true` is mandatory: the default strips a leading U+FEFF from the
  // decoded string while the BOM is still three bytes in the file, which would
  // shift every byte offset and make exact citations unverifiable.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(input.raw);
  if (text.charCodeAt(0) === 0xfeff) warnings.push("source_starts_with_bom");
  if (text.includes("\uFFFD")) warnings.push("source_contains_replacement_characters");
  if (!Buffer.from(text, "utf8").equals(input.raw)) {
    // Invalid UTF-8 was repaired; char offsets stay exact, byte offsets do not.
    warnings.push("byte_offsets_approximate_invalid_utf8");
  }
  if (!text.endsWith("\n")) warnings.push("source_has_no_trailing_newline");

  const lines = splitLines(text);
  // Counted, not just dropped: a document whose blocks are full of running heads is
  // a parse that needs looking at, and a silent cleanup would hide the difference
  // between "this RFC has page markers" and "this parser is dropping content".
  const furnitureLines = lines.filter((line) => isPageFurniture(line)).length;
  if (furnitureLines > 0) warnings.push(`page_furniture_lines_dropped:${furnitureLines}`);
  const toc = extractToc(lines, warnings);
  const { headings, rejected } = findHeadings(lines, toc.numbers);
  rejectedColumnOneItems = rejected;
  if (headings.length === 0) warnings.push("no_section_headings_detected");
  // The old warning counted column-0 numbered lines that were not used as headings
  // and reported it as a rejection, which reads as data loss. It is not: those lines
  // stay as exact, searchable blocks. RFC 1034's nine are headings that were
  // recovered, and RFC 2119's five are the definitions of MUST and SHOULD, which are
  // content by design. What would be a loss is a section the table of contents
  // promises and no heading supplies, so that is what gets reported.
  if (rejectedColumnOneItems > 0) {
    warnings.push(`col0_numbered_items_kept_as_blocks:${rejectedColumnOneItems}`);
  }
  const missing = [...toc.numbers].filter((number) => !headings.some((heading) => heading.number === number));
  if (missing.length > 0) {
    warnings.push(`toc_sections_without_a_heading:${missing.slice(0, 20).join(",")}`);
  }

  const sectionIds = new Map<number, string>();
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]!;
    sectionIds.set(i, `sec_${shortHash(`${input.snapshotId}|${i + 1}|${heading.number}|${heading.title}`)}`);
  }

  interface Region {
    readonly id: string;
    readonly number: string;
    readonly title: string;
    readonly kind: SectionKind;
    readonly parentId: string | null;
    readonly ordinal: number;
    readonly path: readonly string[];
    readonly startLine: number;
    readonly endLine: number;
    readonly headingLine: number;
  }

  const regions: Region[] = [];
  const firstHeadingLine = headings[0]?.line.number ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(firstHeadingLine) || firstHeadingLine > 1) {
    regions.push({
      id: `sec_${shortHash(`${input.snapshotId}|${FRONT_MATTER_ORDINAL}|front`)}`,
      number: "",
      title: "Front Matter",
      kind: "front_matter",
      parentId: null,
      ordinal: FRONT_MATTER_ORDINAL,
      path: ["Front Matter"],
      startLine: 1,
      endLine: firstHeadingLine - 1,
      headingLine: 0,
    });
  }

  headings.forEach((heading, index) => {
    const startLine = heading.line.number;
    const nextStart = headings[index + 1]?.line.number ?? lines.length + 1;
    regions.push({
      id: sectionIds.get(index)!,
      number: heading.number,
      title: heading.title,
      kind: heading.kind,
      parentId: findParentId(headings, sectionIds, index),
      ordinal: regions.length,
      path: sectionPath(heading.number, heading.title),
      startLine,
      endLine: nextStart - 1,
      headingLine: startLine,
    });
  });

  const rawSections: {
    region: Region;
    start: number;
    end: number;
    startLineNumber: number;
    endLineNumber: number;
    body: string;
    furnitureLines: number[];
  }[] = [];
  const rawBlocks: {
    id: string;
    sectionId: string;
    ordinal: number;
    kind: BlockKind;
    start: number;
    end: number;
    startLine: number;
    endLine: number;
    body: string;
  }[] = [];

  for (const region of regions) {
    const sectionLines = collectLines(lines, region.startLine, region.endLine, toc, region);
    // The section body stays a verbatim slice, because its char and byte span have
    // to denote exactly the text they are reported next to. Page furniture inside
    // that span is therefore still present in the text, and a caller who copies
    // `text` into an implementation would copy it. Recording which lines were
    // dropped lets the service hand out a cleaned rendering beside the exact one
    // instead of leaving the caller to guess which lines to distrust.
    const furnitureLines = sectionLines.filter((line) => line.furniture === true).map((line) => line.number);
    let contentBoundary = sectionLines.filter((line) => !isBlank(line));
    if (contentBoundary.length === 0 && region.headingLine > 0) {
      // A heading with no body of its own (e.g. "19. References" immediately
      // followed by "19.1. Normative References") is still a real section.
      const headingLine = lines[region.headingLine - 1];
      if (!headingLine) continue;
      contentBoundary = [headingLine];
    }
    if (contentBoundary.length === 0) continue;
    const first = contentBoundary[0]!;
    const last = contentBoundary[contentBoundary.length - 1]!;
    const body = text.slice(first.start, last.end);
    rawSections.push({
      region,
      start: first.start,
      end: last.end,
      startLineNumber: first.number,
      endLineNumber: last.number,
      body,
      furnitureLines,
    });

    const contentLines = sectionLines.filter((line) => line.number !== region.headingLine);
    for (const group of groupBlocks(contentLines)) {
      const blockOrdinal = rawBlocks.filter((block) => block.sectionId === region.id).length;
      const id = `blk_${shortHash(`${input.snapshotId}|${region.id}|${blockOrdinal}|${group.start}`)}`;
      rawBlocks.push({
        id,
        sectionId: region.id,
        ordinal: blockOrdinal,
        kind: group.kind,
        start: group.start,
        end: group.end,
        startLine: group.startLine,
        endLine: group.endLine,
        body: text.slice(group.start, group.end),
      });
    }
  }

  if (!rawSections.some((section) => section.region.kind === "body")) {
    warnings.push("no_body_sections_detected");
  }

  const boundaries: number[] = [];
  for (const section of rawSections) boundaries.push(section.start, section.end);
  for (const block of rawBlocks) boundaries.push(block.start, block.end);
  const offsets = mapCharOffsets(text, boundaries);

  const sections: Section[] = rawSections.map((section) => {
    const start = offsets.get(section.start)!;
    const end = offsets.get(section.end)!;
    return {
      id: section.region.id,
      snapshot_id: input.snapshotId,
      rfc: input.rfc,
      number: section.region.number,
      title: section.region.title,
      kind: section.region.kind,
      parent_id: section.region.parentId,
      ordinal: section.region.ordinal,
      path: section.region.path,
      text: section.body,
      text_sha256: sha256Hex(section.body),
      furniture_lines: section.furnitureLines,
      ...span(start, end, section.start, section.end, section.startLineNumber, section.endLineNumber),
    };
  });

  const blocks: Block[] = rawBlocks.map((block) => {
    const start = offsets.get(block.start)!;
    const end = offsets.get(block.end)!;
    return {
      id: block.id,
      snapshot_id: input.snapshotId,
      rfc: input.rfc,
      section_id: block.sectionId,
      ordinal: block.ordinal,
      kind: block.kind,
      text: block.body,
      text_sha256: sha256Hex(block.body),
      ...span(start, end, block.start, block.end, block.startLine, block.endLine),
    };
  });

  const quality: ParseQuality = warnings.some((warning) => warning.startsWith("no_") || warning === "toc_unterminated")
    ? "degraded"
    : "complete";

  return { sections, blocks, quality, warnings, textLength: text.length };
}

function span(
  start: { byte: number; codepoint: number },
  end: { byte: number; codepoint: number },
  charStart: number,
  charEnd: number,
  lineStart: number,
  lineEnd: number,
): Span {
  return {
    byte_start: start.byte,
    byte_end: end.byte,
    char_start: charStart,
    char_end: charEnd,
    codepoint_start: start.codepoint,
    codepoint_end: end.codepoint,
    line_start: lineStart,
    line_end: lineEnd,
  };
}

/* -------------------------------------------------------------------------- */
/* Line model                                                                  */
/* -------------------------------------------------------------------------- */

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let number = 1;
  for (;;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const trimmedEnd = end > start && text[end - 1] === "\r" ? end - 1 : end;
    lines.push({ number, start, end: trimmedEnd, value: text.slice(start, trimmedEnd) });
    number += 1;
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

function isPageFurniture(line: Line): boolean {
  // The form feed is tested against the raw value, before trimming. `trim()` removes
  // U+000C as whitespace, so testing the trimmed line asks whether "" is a form feed
  // and the answer is always no — which is why a page break could sit in a section's
  // text while the parser believed it had found none.
  if (/^\f+\s*$/u.test(line.value)) return true;
  const trimmed = line.value.trim();
  return PAGE_FURNITURE.some((pattern) => pattern.test(trimmed));
}

function isBlank(line: Line): boolean {
  return line.value.trim() === "";
}

/* -------------------------------------------------------------------------- */
/* Table of contents                                                           */
/* -------------------------------------------------------------------------- */

function extractToc(lines: readonly Line[], warnings: string[]): TocInfo {
  const start = lines.find(
    (line) => line.value.trim().toLowerCase() === "table of contents" && !/^\s/u.test(line.value),
  );
  if (!start) {
    return {
      startLine: Number.POSITIVE_INFINITY,
      endLine: Number.POSITIVE_INFINITY,
      numbers: new Set<string>(),
    };
  }
  const numbers = new Set<string>();
  let endLine = start.number;
  for (let i = start.number; i < lines.length; i += 1) {
    const line = lines[i]!;
    endLine = line.number;
    if (line.number <= start.number) continue;
    if (!/^\s/u.test(line.value) && looksLikeFirstBodyHeading(line.value.trim())) break;

    if (!/^\s/u.test(line.value)) continue;
    const entry = line.value
      .replace(/^\s+/u, "")
      .replace(/\.{2,}/gu, " ")
      .trim();
    const appendix = APPENDIX_HEADING.exec(entry);
    if (appendix) {
      numbers.add(`Appendix ${appendix[1]!}`);
      continue;
    }
    const numbered = NUMBERED_HEADING.exec(entry);
    if (!numbered) continue;
    const title = numbered[2]!.replace(/\s+\d+$/u, "").trim();
    if (title === "" || title.length > MAX_HEADING_CHARS) continue;
    numbers.add(numbered[1]!);
  }
  if (endLine <= start.number) warnings.push("toc_unterminated");
  return { startLine: start.number, endLine, numbers };
}

function looksLikeFirstBodyHeading(value: string): boolean {
  const appendix = APPENDIX_HEADING.exec(value);
  if (appendix) return true;
  const numbered = NUMBERED_HEADING.exec(value);
  if (numbered) return isHeadingLike(numbered[2]!);
  return UNNUMBERED_HEADING.test(value);
}

/* -------------------------------------------------------------------------- */
/* Headings                                                                    */
/* -------------------------------------------------------------------------- */

function isHeadingLike(rest: string): boolean {
  const text = rest.trim();
  if (text === "" || text.length > MAX_HEADING_CHARS) return false;
  if (/[,;]/u.test(text)) return false;
  if (/\.$/u.test(text)) return false;
  if (text.split(/\s+/u).length > MAX_HEADING_WORDS) return false;
  // RFC 2119 and friends enumerate the keywords themselves as column-1
  // numbered content ("1. MUST   This word, or the terms ..."). A heading
  // that merely starts with a keyword is a definition entry, not a section.
  if (KEYWORD_LEAD.test(text)) return false;
  return true;
}

function findHeadings(
  lines: readonly Line[],
  tocNumbers: ReadonlySet<string>,
): { headings: Heading[]; rejected: number } {
  const out: Heading[] = [];
  let rejected = 0;
  for (const line of lines) {
    if (/^\s/u.test(line.value) || line.value.trim() === "") continue;
    const trimmed = line.value.trim();

    const appendix = APPENDIX_HEADING.exec(trimmed);
    if (appendix) {
      let title = (appendix[2] ?? "").trim();
      if (title === "") {
        const next = lines[line.number];
        title = next && /^\s/u.test(next.value) ? next.value.trim() : "";
      }
      if (title.length > 0 && title.length <= MAX_HEADING_CHARS) {
        out.push({ line, number: `Appendix ${appendix[1]!}`, title, kind: "appendix" });
        continue;
      }
    }

    const numbered = NUMBERED_HEADING.exec(trimmed);
    if (numbered) {
      const number = numbered[1]!;
      const rest = numbered[2]!;
      if (tocNumbers.has(number) || isHeadingLike(rest)) {
        const title = rest.trim();
        out.push({ line, number, title, kind: classifyKind(number, title) });
      } else {
        rejected += 1;
      }
      continue;
    }

    if (UNNUMBERED_HEADING.test(trimmed) && trimmed.length <= 60) {
      // Unnumbered sections are addressable by their title ("Abstract",
      // "References", "Author's Address") so `read(section=…)` works for them.
      out.push({ line, number: trimmed, title: trimmed, kind: classifyKind("", trimmed) });
    }
  }
  return { headings: out, rejected };
}

function classifyKind(number: string, title: string): SectionKind {
  const lower = title.toLowerCase();
  if (number.startsWith("Appendix")) return "appendix";
  if (lower === "references" || lower === "normative references" || lower === "informative references")
    return "references";
  if (lower === "index") return "index";
  if (lower.startsWith("author") || lower === "contributors") return "authors";
  if (
    lower === "abstract" ||
    lower.startsWith("status of") ||
    lower === "notice of tbd" ||
    lower === "copyright notice" ||
    lower === "full copyright statement" ||
    lower === "intellectual property"
  ) {
    return "status";
  }
  if (lower === "acknowledgements" || lower === "acknowledgments") return "body";
  return "body";
}

function sectionPath(number: string, title: string): string[] {
  if (number === "" || number === title) return [title];
  if (number.startsWith("Appendix")) return [...number.split(/\s+/u), title];
  return [...number.split("."), title];
}

function findParentId(
  headings: readonly Heading[],
  sectionIds: ReadonlyMap<number, string>,
  index: number,
): string | null {
  const current = headings[index]!.number;
  if (current === "" || current === headings[index]!.title || current.startsWith("Appendix")) return null;
  const parts = current.split(".");
  for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
    const parentNumber = parts.slice(0, depth).join(".");
    for (let i = index - 1; i >= 0; i -= 1) {
      if (headings[i]!.number === parentNumber) return sectionIds.get(i) ?? null;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Lines, blocks                                                               */
/* -------------------------------------------------------------------------- */

interface RegionLike {
  readonly headingLine: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: SectionKind;
}

function collectLines(
  lines: readonly Line[],
  startLine: number,
  endLine: number,
  toc: TocInfo,
  region: RegionLike,
): Line[] {
  const out: Line[] = [];
  for (let number = startLine; number <= endLine && number <= lines.length; number += 1) {
    const line = lines[number - 1]!;
    if (number >= toc.startLine && number <= toc.endLine) continue;
    if (number === region.headingLine) continue;
    // Furniture is tested before blankness, and the order matters. A form feed is
    // whitespace, so `trim()` empties it and a `\f`-only line looks like any other
    // blank line. That is right for grouping — it separates blocks — but it left the
    // raw byte inside the section's verbatim slice, where a caller copying `text`
    // picked up an invisible control character. Marking it as furniture reports it
    // and lets `text_clean` drop it.
    if (isPageFurniture(line)) {
      // Dropped furniture must still *separate* blocks, otherwise a block
      // would span bytes that are not in its text and a sentence crossing a
      // page break would not be contiguous in the raw file.
      out.push({ number, start: line.start, end: line.start, value: "", furniture: true });
      continue;
    }
    // Blank lines are structural: they separate paragraphs.
    if (isBlank(line)) {
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out;
}

interface BlockGroup {
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: BlockKind;
}

function groupBlocks(lines: readonly Line[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index]!.value.trim() === "") index += 1;
    if (index >= lines.length) break;
    const start = index;
    while (index < lines.length && lines[index]!.value.trim() !== "") index += 1;
    const chunk = lines.slice(start, index);
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    groups.push({
      start: first.start,
      end: last.end,
      startLine: first.number,
      endLine: last.number,
      kind: classifyBlock(chunk),
    });
  }
  return groups;
}

function classifyBlock(chunk: readonly Line[]): BlockKind {
  const first = chunk[0]!.value;
  if (/^\s*\[\s*[A-Za-z0-9][A-Za-z0-9._-]*(?:\s*,\s*(?:Section|Appendix)[^\]]*)?\s*\]\s+/u.test(first)) {
    return "reference_entry";
  }
  if (/^\s*(?:[-*•]|\(?[0-9a-zA-Z]{1,4}[.)])\s+\S/u.test(first)) return "list_item";
  if (chunk.every((line) => /^\s*\|/.test(line.value) || line.value.trim() === "|")) return "table";
  const indents = chunk.map((line) => indentWidth(line.value));
  const minIndent = Math.min(...indents);
  if (minIndent >= 6) {
    const tableLike = chunk.every((line) => /\|/.test(line.value) || / {2,}\S/u.test(line.value.trim()));
    return tableLike ? "table" : "preformatted";
  }
  return "paragraph";
}

function indentWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 8;
    else break;
  }
  return width;
}

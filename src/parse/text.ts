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
  /**
   * The rule of dashes or equals signs under a typeset title, when the heading is one.
   *
   * The heading SPANS both lines. Recognising the title and leaving its underline in the
   * body put a row of dashes at the head of the section's first block, so the section's
   * first real statement began `------ <sentence>`: not classifiable as a sentence, and
   * not quotable, in all 75 underlined headings the parser recognises. It is the same
   * class of defect as the running heads this file already drops, one document class
   * later, and it is the reason RFC 768 yielded zero golden rules while containing "The
   * UDP module must be able to determine the source and destination internet addresses".
   */
  readonly underlineLine: number | null;
  readonly number: string;
  readonly title: string;
  readonly kind: SectionKind;
}

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(\S.*)$/u;
/**
 * An appendix heading, matched without regard to capitalisation.
 *
 * The `i` flag is load-bearing and was a silent data loss. RFC 1812 writes its appendix
 * titles in capitals - `APPENDIX A. REQUIREMENTS FOR SOURCE-ROUTING HOSTS` at L8071 - and
 * a case-sensitive pattern does not match, so no appendix heading existed, section 11
 * (`11. REFERENCES`, typed `references`) ran from L7433 to L9258 and CONTAINED Appendices
 * A through F. The extractor's design skips a `references` section, so every requirement
 * those appendices state was absent from `requirements` with nothing to say so: the
 * tool's own answer to "where are the appendix obligations" was "those are references".
 * The same flag fixes the contents scan, which used the identical pattern, so a document
 * whose contents lists `APPENDIX B. GLOSSARY` now has a promised number to match against.
 *
 * The label is a RUN of capitals, not one capital, because RFC 959 numbers its appendices
 * `APPENDIX I`, `APPENDIX II` and `APPENDIX III`: with a single `[A-Z]` all three were
 * read as appendix I, and the outline offered the caller the same address three times.
 */
const APPENDIX_HEADING = /^Appendix\s+([A-Z]+(?:\.\d+)*)\.?\s*(\S.*)?$/iu;
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
  // The 1973-1984 typeset format puts the date alone on one line and closes the page
  // with the title and the RFC number, with no month and year to anchor the pattern
  // above. RFC 768 and RFC 792 print `28 Aug 1980` and `User Datagram Protocol ...
  // RFC 768`; neither was claimed, so the date survived into a caller's copy and - the
  // part that is not cosmetic - `28 August 1980` in the front matter was then read as
  // a section numbered 28.
  /^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}$/u,
  /^[A-Z][^\n]{0,60}?\s{2,}RFC\s+\d{1,5}\s*$/u,
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
  const { headings, rejected, underlined, indentedSubsections } = findHeadings(lines, toc);
  rejectedColumnOneItems = rejected;
  // Counted, like the furniture: a document whose titles are found only because they
  // are underlined or indented is a parse whose reach depends on how the RFC was
  // typeset, and a silent improvement would make that dependence invisible.
  if (underlined > 0) warnings.push(`underlined_headings_recognised:${underlined}`);
  if (indentedSubsections > 0) warnings.push(`indented_subsection_headings_recognised:${indentedSubsections}`);
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
    /** The rule under a typeset title, part of the heading and skipped with it. */
    readonly underlineLine: number | null;
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
      underlineLine: null,
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
      underlineLine: heading.underlineLine,
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

    const contentLines = sectionLines.filter(
      (line) => line.number !== region.headingLine && line.number !== region.underlineLine,
    );
    for (const group of groupBlocks(contentLines, region.kind)) {
      // `ordinal` is a DOCUMENT counter, not a per-section one, and the difference is
      // not cosmetic: `listBlocksWithKeywords` reads blocks `ORDER BY ordinal` and hands
      // them to the candidate pass as the document's block sequence. With a per-section
      // counter that order is `ordinal 0 of every section, then ordinal 1 of every
      // section, ...`, so the block that is first in the document was read LAST -
      // measured on 155 of 159 snapshots - and because the counter repeats, the SQL
      // `ORDER BY` is not a total order at all: 3 864 duplicate `(snapshot_id, ordinal)`
      // pairs were resolved by the `blocks` primary key, which is `id`, which is a
      // sha256. So the content of a derived, quotable candidate list depended on hash
      // order within an ordinal bucket, and `max_candidates` truncation decided which
      // candidates survive by that order. `rawBlocks.length` is a single running count
      // over regions in document order and blocks in document order within a region, so
      // it is unique per snapshot and reading by it is reading in document order.
      //
      // The per-section index is still computed, and still used, for the block ID. Keeping
      // the identity formula on the old input is deliberate: `blk_` ids are cited, they
      // are in `citation_id` derivations, and a document whose structure did not change
      // must not have its ids change. `ordinal` is an ordering field; the id is an
      // identity. MIGRATION, for whoever owns the store: no schema change is needed -
      // `blocks.ordinal` is `INTEGER NOT NULL` with `PRIMARY KEY (snapshot_id, id)` and no
      // uniqueness constraint on `(snapshot_id, ordinal)` - but every stored value is now
      // a document counter, so every snapshot must be RE-DERIVED (`reanalyze`) for the new
      // order to take effect, and a snapshot derived by an older parser keeps the old
      // per-section values. `ensureLossCounters` is the precedent for a repair that is
      // applied where the value is read rather than by re-minting every id; an
      // `ORDER BY char_start` in `listBlocksWithKeywords` would be the same repair with
      // no re-derive at all, and is the better long-term fix because it is a property of
      // the bytes rather than of the counter.
      const blockOrdinal = rawBlocks.filter((block) => block.sectionId === region.id).length;
      const id = `blk_${shortHash(`${input.snapshotId}|${region.id}|${blockOrdinal}|${group.start}`)}`;
      rawBlocks.push({
        id,
        sectionId: region.id,
        ordinal: rawBlocks.length,
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

/**
 * The next line that carries content: blanks, form feeds and running heads are skipped
 * so an underline or an indent is judged against the line a reader would see next.
 */
function nextContentLine(lines: readonly Line[], line: Line): Line | null {
  for (let i = line.number; i < lines.length; i += 1) {
    const candidate = lines[i]!;
    if (isBlank(candidate) || isPageFurniture(candidate)) continue;
    return candidate;
  }
  return null;
}

const UNDERLINE = /^([-=*~+])\1{2,}$/u;

/**
 * A heading underlined with a rule of dashes or equals signs, and the line of that rule.
 *
 * RFCs from 1973 to the mid-1980s were typeset rather than generated, and their
 * section titles carry no number and no fixed name - RFC 768 titles its sections
 * "Introduction", "Format", "Fields" - so a fixed-title list cannot find them. The
 * result was not a missing convenience: the whole body of those documents became one
 * undifferentiated section, `read(section=...)` could not address any of it, and every
 * statement in RFC 768 was reported under "Front Matter".
 *
 * The shape is unambiguous in practice: a short title line whose only neighbour is a
 * run of one repeated punctuation character. A figure or a table that happens to be
 * underlined does not have a title line above the rule, and the rule is required to be
 * at least three characters and most of the title's width, which is what a typeset
 * underline looks like and what a stray dash row does not.
 *
 * The rule's LINE NUMBER is returned, not a boolean, because the rule is part of the
 * heading. It used to be left in the body, where it became the first line of the
 * section's first block: `read(768, "Fields")` returned `"------\n\nSource Port is an
 * optional field, ..."`, so the section's first real statement opened with a row of
 * dashes and was neither classifiable as a sentence nor quotable. All 75 underlined
 * headings the parser recognises had it, and it is why RFC 768 produced zero golden
 * rules while containing "The UDP module must be able to determine the source and
 * destination internet addresses".
 */
function underlinedHeadingRule(lines: readonly Line[], line: Line): number | null {
  const title = line.value.trim();
  if (title.length === 0 || title.length > MAX_HEADING_CHARS) return null;
  if (!/\p{L}/u.test(title)) return null;
  if (/[.,;]\s*$/u.test(title)) return null;
  const next = nextContentLine(lines, line);
  if (!next) return null;
  const rule = next.value.trim();
  if (!UNDERLINE.test(rule)) return null;
  if (!(rule.length >= 3 && rule.length * 5 >= title.length * 3)) return null;
  return next.number;
}

/**
 * An indented numbered line that is a subsection heading, not a paragraph.
 *
 * The 1989 host-requirements RFCs and their contemporaries set body text at an indent
 * of eleven columns and set their subsection titles by indenting them, three columns
 * per level:
 *
 *      3.3  SPECIFIC ISSUES
 *           3.3.1  Routing Outbound Datagrams
 *                  3.3.1.1  Local/Remote Decision
 *
 * `findHeadings` treated every indented line as body text, so RFC 1122's outline was
 * five entries long - 1 through 5 - and the seven hundred statements under those
 * headings were unreachable: not unreadable, unreachable, because no query returns a
 * section the outline does not name.
 *
 * Two conditions keep this from turning a paragraph into a heading, and both are
 * properties of the typeset page rather than of any document's subject:
 *
 *   - the number must be at least two components deep, because a level-1 title in
 *     these documents sits at column 0 and is already found there; a paragraph that
 *     opens "1983 must ..." must not become a section, and a bare integer cannot pass;
 *   - the line below must be indented FURTHER than the candidate. Under a real
 *     subsection title the body steps in; inside a paragraph the next line continues
 *     at the same indent or returns to one.
 */
function isIndentedSubsectionHeading(lines: readonly Line[], line: Line, knownTopLevel: ReadonlySet<string>): boolean {
  const trimmed = line.value.trim();
  const numbered = NUMBERED_HEADING.exec(trimmed);
  if (!numbered) return false;
  const number = numbered[1]!;
  if (!number.includes(".")) return false;
  if (!knownTopLevel.has(number.split(".")[0]!)) return false;
  if (!isHeadingLike(numbered[2]!)) return false;
  const indent = line.value.length - line.value.trimStart().length;
  const next = nextContentLine(lines, line);
  if (!next) return false;
  const nextIndent = next.value.length - next.value.trimStart().length;
  return nextIndent > indent;
}

/* -------------------------------------------------------------------------- */
/* Table of contents                                                           */
/* -------------------------------------------------------------------------- */

function extractToc(lines: readonly Line[], warnings: string[]): TocInfo {
  // Matched on the trimmed value, so indentation does not matter. RFC 1035 writes its
  // header as "                           Table of Contents" at column 28, and a
  // column-0 requirement meant the whole contents was never recognised: its entries
  // were indexed as body text, which put fragments like "Inverse queries (Optional)
  // 40 6.4.1." into search results and candidate lists as though the RFC had said it.
  // The absence is also reported, because an unrecognised contents is a parse gap and
  // not a stylistic fact.
  const start = lines.find((line) => line.value.trim().toLowerCase() === "table of contents");
  if (!start) {
    warnings.push("table_of_contents_header_not_found");
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
  // A dot leader is a contents entry, and a contents entry is a promise about a heading,
  // not a heading. The `inToc` region test already says that for a document whose
  // contents header was found; this says it for one whose contents header was NOT found,
  // which is how RFC 791's `APPENDIX A:  Examples & Scenarios ..... 34` became a section
  // the moment `APPENDIX_HEADING` learned to match capitals - a contents entry with a
  // page number on it, filed as a body section with a 34 in its title.
  if (/\.{3,}/u.test(text)) return false;
  if (text.split(/\s+/u).length > MAX_HEADING_WORDS) return false;
  // RFC 2119 and friends enumerate the keywords themselves as column-1
  // numbered content ("1. MUST   This word, or the terms ..."). A heading
  // that merely starts with a keyword is a definition entry, not a section.
  if (KEYWORD_LEAD.test(text)) return false;
  return true;
}

/**
 * Does this document number its sections at all?
 *
 * A bare integer at column 0 is offered to the heading matcher because that is what a
 * section heading looks like, and a bare integer at column 0 is also how a typeset
 * survey writes its findings. RFC 876 has no numbered sections at all; its host table
 * and its prose produce `483 hosts were tested`, `283 are claimed by the host table to
 * support SMTP`, `162 hosts out of the 285 connectable hosts (57%) ...`, and nine of
 * those became sections, so 33 600 of the document's 36 300 bytes (93%) were filed under
 * numbers lifted from the middle of sentences and the response said `quality: complete`.
 * The outline a caller navigates by read:
 *
 *     483 body :: hosts were tested
 *     162 body :: hosts out of the 285 connectable hosts (57%) immediately rejected
 *
 * The test is label-free and structural, and it asks the document itself: a document that
 * numbers its sections leaves at least one of four marks, and a document that leaves none
 * of them is not numbering anything, so a bare integer in it is prose.
 *
 *   (a) a table of contents that promises at least one number;
 *   (b) a DOTTED number anywhere in the document - `3.3`, `7.1`, `9.3.5` - which only a
 *       numbering document has, and which RFC 876 and RFC 768 both lack entirely. This
 *       includes the indented form, because the 1989 host-requirements RFCs set their
 *       subsection titles by indenting them and are numbered at every level;
 *   (c) a top-level `1` at column 0;
 *   (d) an appendix heading, which is numbered even in a document whose sections are not.
 *
 * It rejects exactly two things across the 43-document measurement set: RFC 876's nine
 * fabricated numbers (33.6 KB, 93% of the document) and RFC 768's `28 Aug 1980` date
 * stamp - which `findHeadings` now also refuses because it is page furniture, see
 * `isPageFurniture`, and which this test catches independently. It accepts every real
 * heading in the same 43 documents, including RFC 2459's 307 numbered lines in a document
 * with no contents at all, and RFC 3207's `4.1`/`4.2`/`4.3`, whose level-1 sections are
 * written with a period and a title-case letter.
 *
 * It is not a general filter for fabricated sections, and it is not claimed to be one: the
 * numbers it cannot reach are the ones in a document that DOES number its sections - RFC
 * 2300's `1305 obsoletes 1119 Stan/Rec ...`, a table row, and RFC 1035's `25 (SMTP). If
 * this bit is set, ...`, a wrapped sentence. Every bound I tried that reached those also
 * reached real sections - a "top-level numbers are at most K distinct values" bound
 * deletes RFC 1057's seventeen real `7.x`/`9.x` titles, and dropping the indented-form
 * clause in (b) here deletes RFC 1122's and RFC 1123's whole outline - so the wider class
 * is reported as measured rather than half-fixed.
 *
 * The fourth condition lives at the call site and is the reason this test is safe to run
 * on a document with no contents at all: a bare, undotted number that CARRIES ITS
 * TERMINATING PERIOD is accepted whatever else the document does, because `2.  Rules` is
 * the publication format's own spelling of a heading and `483 hosts were tested` is not
 * one. Measured over the 43-document set, every undotted number without a period is either
 * a fabricated count (RFC 876, RFC 768's date stamp) or lives in a document that has a
 * mark of its own (RFC 2459's `1 Introduction`, RFC 2136's `1 - Definitions`, RFC 2845's
 * `1 - Introduction`).
 */
function numbersItsSections(lines: readonly Line[], toc: TocInfo): boolean {
  if (toc.numbers.size > 0) return true;
  for (const line of lines) {
    if (isBlank(line) || isPageFurniture(line)) continue;
    const trimmed = line.value.trim();
    if (!/^\s/u.test(line.value) && APPENDIX_HEADING.test(trimmed)) return true;
    const numbered = NUMBERED_HEADING.exec(trimmed);
    if (!numbered) continue;
    // (b) A dotted number, indented or not, is a hierarchy and hierarchies are numbered.
    if (numbered[1]!.includes(".")) return true;
    // (c) A level-1 `1`, at column 0, where a level-1 title sits in every era.
    if (numbered[1] === "1" && !/^\s/u.test(line.value)) return true;
  }
  return false;
}

/** `2.  Rules` carries its period; `483 hosts were tested` does not. */
function numberCarriesItsPeriod(trimmed: string): boolean {
  return /^\d+\.(?:\s|$)/u.test(trimmed);
}

function findHeadings(
  lines: readonly Line[],
  toc: TocInfo,
): { headings: Heading[]; rejected: number; underlined: number; indentedSubsections: number } {
  const out: Heading[] = [];
  let rejected = 0;
  let underlined = 0;
  let indentedSubsections = 0;
  const inToc = (line: Line) => line.number > toc.startLine && line.number <= toc.endLine;
  // Page furniture is not offered to the heading matcher at all, exactly as `collectLines`
  // does not offer it to the block grouper. These are two different decisions and only one
  // of them used to be made: the 1973-1984 date stamp `28 Aug 1980` was added to
  // PAGE_FURNITURE, so the TEXT was blanked, but `findHeadings` never consulted it, so
  // NUMBERED_HEADING still read "28" as a number and "Aug 1980" as a title and the
  // section was created regardless. RFC 768's outline listed a section called `28` whose
  // content was the running head of a printed page. Checked against the whole corpus
  // because a date stamp is a page-level artefact: every typeset-era document carries one
  // per page, and the same line in a front matter would be read as a section numbered 28.
  const furniture = (line: Line): boolean => isPageFurniture(line);
  // A bare integer in a document that shows no sign of numbering its sections is a
  // quantity in a sentence, unless it carries its terminating period - which is how the
  // publication format spells a heading. See `numbersItsSections` and
  // `numberCarriesItsPeriod`.
  const numberedDocument = numbersItsSections(lines, toc);
  const numberIsAddressable = (number: string, trimmed: string): boolean => {
    if (toc.numbers.has(number)) return true;
    if (numberedDocument) return true;
    if (number.includes(".")) return true;
    return numberCarriesItsPeriod(trimmed);
  };
  // A number is only a heading if its first component is a heading this document
  // already has, or the contents promises it. Collected first because it is what
  // separates an indented subsection title from a paragraph that opens with a number.
  const knownTopLevel = new Set<string>();
  for (const line of lines) {
    if (isBlank(line) || furniture(line)) continue;
    if (/^\s/u.test(line.value)) continue;
    const trimmed = line.value.trim();
    const numbered = NUMBERED_HEADING.exec(trimmed);
    if (
      numbered &&
      numberIsAddressable(numbered[1]!, trimmed) &&
      (toc.numbers.has(numbered[1]!) || isHeadingLike(numbered[2]!))
    ) {
      knownTopLevel.add(numbered[1]!);
    }
  }

  for (const line of lines) {
    if (line.value.trim() === "") continue;
    if (furniture(line)) continue;
    const trimmed = line.value.trim();
    const ruleLine = underlinedHeadingRule(lines, line);
    // An indented line is body text, except when its whole content is one of the
    // fixed unnumbered titles, when it is a subsection title of a typeset page, or
    // when it is underlined. Each of those is a heading wherever it sits - except
    // inside the contents, where an entry is a promise about a heading, not one.
    const indentedSubsection = !inToc(line) && isIndentedSubsectionHeading(lines, line, knownTopLevel);
    if (/^\s/u.test(line.value) && !UNNUMBERED_HEADING.test(trimmed) && !indentedSubsection && ruleLine === null) {
      continue;
    }

    const appendix = APPENDIX_HEADING.exec(trimmed);
    if (appendix) {
      let title = (appendix[2] ?? "").trim();
      if (title === "") {
        // The title is on its own line under the label, set in from the margin. A rule of
        // dashes under the label is that line's underline and not its title, and reading
        // it as one gave RFC 820 a section called "Appendix A" titled "----------".
        const next = lines[line.number];
        const below = next ? next.value.trim() : "";
        title = next && /^\s/u.test(next.value) && !UNDERLINE.test(below) ? below : "";
      }
      if (title.length > 0 && title.length <= MAX_HEADING_CHARS && isHeadingLike(title)) {
        out.push({ line, underlineLine: ruleLine, number: `Appendix ${appendix[1]!}`, title, kind: "appendix" });
        continue;
      }
    }

    const numbered = NUMBERED_HEADING.exec(trimmed);
    if (numbered) {
      const number = numbered[1]!;
      const rest = numbered[2]!;
      if (numberIsAddressable(number, trimmed) && (toc.numbers.has(number) || isHeadingLike(rest))) {
        const title = rest.trim();
        if (indentedSubsection) indentedSubsections += 1;
        out.push({ line, underlineLine: ruleLine, number, title, kind: classifyKind(number, title) });
      } else {
        rejected += 1;
      }
      continue;
    }

    if (ruleLine !== null) {
      underlined += 1;
      out.push({ line, underlineLine: ruleLine, number: trimmed, title: trimmed, kind: classifyKind("", trimmed) });
      continue;
    }

    if (UNNUMBERED_HEADING.test(trimmed) && trimmed.length <= 60) {
      // Unnumbered sections are addressable by their title ("Abstract",
      // "References", "Author's Address") so `read(section=…)` works for them. The
      // title is matched on the trimmed value, so indentation does not decide it:
      // RFC 1035 writes its contents header at column 28, and a document whose
      // contents could not be addressed could not be told apart from one that has
      // none.
      out.push({ line, underlineLine: null, number: trimmed, title: trimmed, kind: classifyKind("", trimmed) });
    }
  }
  return { headings: out, rejected, underlined, indentedSubsections };
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
  readonly underlineLine: number | null;
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
    // The rule of dashes under a typeset title belongs to the heading, so it leaves with
    // it. See `underlinedHeadingRule`.
    if (region.underlineLine !== null && number === region.underlineLine) continue;
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
  /** Assigned in a second pass, once the section-level facts are known. */
  kind: BlockKind;
}

function groupBlocks(lines: readonly Line[], sectionKind: SectionKind): BlockGroup[] {
  const groups: BlockGroup[] = [];
  const chunks: Line[][] = [];
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
      kind: "unknown",
    });
    chunks.push(chunk);
  }
  // Two facts about the SECTION, decided before any block is typed, because both are
  // statements about the section rather than about one block:
  //
  //   - how many of its blocks open with a citation tag. One is a sentence about a
  //     document; two or more is a printed reference list. See `looksLikeCitationEntry`.
  //   - the page's right margin, taken from the masthead if the front matter has one, and
  //     with it the index of the document's title. See `isCentredTitleBlock`.
  let tagged = 0;
  let margin: number | null = null;
  let mastheadIndex = -1;
  for (let i = 0; i < chunks.length; i += 1) {
    if (CITATION_TAG.test(chunks[i]![0]!.value)) tagged += 1;
    if (margin === null) {
      const found = mastheadRightMargin(chunks[i]!);
      if (found !== null) {
        margin = found;
        mastheadIndex = i;
      }
    }
  }
  // RFC 9920 section 5 fixes the order of the front page: the header field block, then the
  // title, then the abstract. So the title is the first block after the masthead that is
  // centred on the measure the masthead establishes - and the centring is what makes it
  // the title rather than whatever is printed next, which in RFC 820 is a line reading
  // `Obsoletes RFCs:  790, 776, 770, 762,`.
  let titleIndex = -1;
  if (sectionKind === "front_matter" && margin !== null) {
    for (let i = mastheadIndex + 1; i < chunks.length; i += 1) {
      if (isCentredTitleBlock(chunks[i]!, sectionKind, margin)) {
        titleIndex = i;
        break;
      }
    }
  }
  for (let i = 0; i < groups.length; i += 1) {
    groups[i]!.kind = classifyBlock(chunks[i]!, sectionKind, tagged >= 2, i === titleIndex);
  }
  return groups;
}

/**
 * Does this chunk contain sentences, or is it aligned/notation?
 *
 * The distinction that matters is compositional, not visual. RFCs from 1973 to the
 * mid-1990s were typeset, and they indent their BODY TEXT: RFC 1122 sets every
 * paragraph at twelve columns and RFC 1123 at three. A test that reads indentation as
 * "not prose" therefore classified the entire body of those documents as
 * preformatted, and the strict extractor - which reads prose blocks - reported 17
 * requirements for RFC 1122 while its own candidate list held 255 upper-case
 * modal-and-demand statements from the same text. Those are not provisional
 * statements: they are the requirements of the document, counted as if absent.
 *
 * A paragraph is prose whatever column it starts in. What actually marks notation is
 * the absence of sentences: no terminal punctuation, a low share of word-like tokens,
 * internal column alignment, or box-drawing. Every RFC from 1973 onward is separated
 * on that basis, and none of it depends on the document's subject.
 */
function looksLikeProse(chunk: readonly Line[]): boolean {
  const text = chunk
    .map((line) => line.value.trim())
    .filter((value) => value !== "")
    .join(" ");
  if (text === "") return false;
  if (looksLikeNotation(chunk)) return false;
  // Sentences, or the fragments a list item ends on. A chunk with neither is a table
  // row, a header field block, or pseudo-code.
  if (!/[.!?](?:\s|$)/u.test(text) && !(/^[A-Z]/u.test(text) && /:\s*$/u.test(chunk[chunk.length - 1]!.value.trim()))) {
    return false;
  }
  const words = text.split(/\s+/u).filter((w) => w !== "");
  if (words.length === 0) return false;
  const wordish = words.filter((w) => /^[A-Za-z][A-Za-z'-]*[.,;:)]?$/u.test(w)).length;
  return wordish / words.length >= 0.5;
}

/**
 * Is this the RFC's masthead - the RFC 9920 section 5 header field block?
 *
 * THE TEST, and it is entirely internal to the block. A masthead is a block in which
 *
 *   1. no line carries a table delimiter (`|`, `+`) and no line is a rule row;
 *   2. no line carries MORE THAN ONE run of three or more spaces, so the block has at
 *      most two columns and therefore no internal column structure to read as data;
 *   3. at least two lines have a second column, and the second column is RIGHT-ALIGNED -
 *      see `rightAlignedEdge`.
 *
 * (3) is the discriminator, and it is the only one that matters. A data table's columns
 * are left-aligned at fixed start positions, so its last column is ragged on the right;
 * a header field block's right column is right-aligned to a shared right margin, because
 * the second column holds a list of unrelated values (author, organisation, month, year)
 * that have nothing to do with one another. `Network Working Group ... J. Iyengar, Ed.`,
 * `Request for Comments: 9000 ... Fastly`, `ISSN: 2070-1721 ... Mozilla` and a bare
 * `... May 2021` all end at column 72. A table does not do that.
 *
 * Why it had to be fixed: every RFC's masthead was typed `table` or `preformatted`, so
 * every ingested document had at least one block of a kind the extractor refuses to read
 * on its kind alone, and `coverage.completeness` was therefore `partial` for all of them
 * and `complete` was unreachable for any document ever. The honest answer to "may I treat
 * `total_requirements` as this document's normative content?" was "no" for the whole
 * corpus, on the strength of a block that cannot state a rule - it is a closed vocabulary
 * of document metadata, all of which the catalog row already carries.
 *
 * What it is NOT tested on: position, indent, or the word "Network". A test that says
 * "the block above the abstract is the masthead" is a test about where the block sits, and
 * it would keep mis-typing every two-column table in the corpus as a header. It is also
 * not tested on the *count* of documents, so the same predicate runs on a body table:
 * measured over 43 documents spanning 1980-2022, the only blocks that satisfy it are
 * mastheads.
 */
function isMastheadHeaderBlock(chunk: readonly Line[]): boolean {
  const values = chunk.map((line) => line.value).filter((value) => value.trim() !== "");
  if (values.length < 2) return false;
  if (values.some((value) => /[|+]/u.test(value) || UNDERLINE.test(value.trim()))) return false;
  return rightAlignedEdge(values) !== null;
}

/**
 * The right margin a two-column block is set to, if it is right-aligned to one.
 *
 * The masthead is the one block in a document that states the measure the rest of the front
 * page is set to, and it states it by right-aligning its second column.
 *
 * The MODAL edge rather than a unanimous one, because a masthead's left column can wrap
 * and a wrapped label is a one-column line that still ends at the margin:
 * `           7538, 7615, 7694` in RFC 9110 ends at column 40, not 72. Most of the
 * two-column lines still end at 72. A data table's last column is ragged on the right, so
 * no edge repeats at all - which is the whole discriminator - so the test is the most
 * common edge, shared by at least two lines and by at least 60% of the two-column lines.
 */
function rightAlignedEdge(values: readonly string[]): number | null {
  const counts = new Map<number, number>();
  let twoColumn = 0;
  for (const value of values) {
    // Gaps are counted from column 0, leading indent included, and that is deliberate
    // rather than lazy. Counting from the first non-space character instead would read a
    // dot-leader contents as a header field block - RFC 2459's `   1  Introduction
    // .......................................... 1` is two columns whose right column is
    // right-aligned, which is the masthead's signature exactly - and would then type a
    // table of contents as body prose. The cost of the strict reading is one document:
    // RFC 9110's masthead wraps its left column (`Obsoletes: 2818, ... 7235,` then
    // `           7538, 7615, 7694`), so its masthead and its title keep the kinds they
    // had. Two blocks in one document, and stated rather than bought with a contents.
    const gaps = value.match(/ {3,}(?=\S)/gu) ?? [];
    // Two gaps means three columns: a table, and the question is a different one.
    if (gaps.length > 1) return null;
    if (gaps.length === 0) continue;
    twoColumn += 1;
    const edge = value.replace(/\s+$/u, "").length;
    counts.set(edge, (counts.get(edge) ?? 0) + 1);
  }
  if (twoColumn < 2) return null;
  let best = 0;
  let bestCount = 0;
  for (const [edge, count] of counts) {
    if (count > bestCount) {
      best = edge;
      bestCount = count;
    }
  }
  if (bestCount < 2 || bestCount * 5 < twoColumn * 3) return null;
  return best;
}

/**
 * The page's right margin, as the masthead establishes it. `null` for a front matter with
 * no masthead, and the title test then does not run - see `isCentredTitleBlock`.
 */
function mastheadRightMargin(chunk: readonly Line[]): number | null {
  const values = chunk.map((line) => line.value).filter((value) => value.trim() !== "");
  if (values.length < 2) return null;
  if (values.some((value) => /[|+]/u.test(value) || UNDERLINE.test(value.trim()))) return null;
  return rightAlignedEdge(values);
}

/**
 * Is this block set as a title - centred on the front page's measure?
 *
 * A title is not prose and it is not notation, and it is the one block kind in the
 * vocabulary that cannot state a rule by construction - which is why the loss counter
 * in `src/store/database.ts` already declines to count `heading` towards "may contain
 * normative text", with the reason written there: a heading is a title. Using that kind is
 * what keeps the counter's number TRUE rather than blind: the block is still counted as
 * unscanned and is still bucketed as `heading` in `blocks_skipped_by_kind`; what it is not
 * counted as is a possible source of obligations. Typing it `paragraph` would have been
 * the blind fix - it would have removed the entry and handed the extractor's strict pass a
 * document title to scan for RFC 2119 keywords.
 *
 * The test: the block is in the front matter; every line is set in from the margin, none
 * carries a delimiter or a rule, none carries an internal run of three or more spaces (so
 * there is no column structure - and a title that wraps over two or three lines still
 * passes, which a "single line" test would not); none ends in sentence punctuation; the
 * lines do not all end at one column (that is the masthead's signature, not a title's);
 * and the FIRST line is CENTRED on the margin the masthead establishes - its own left
 * indent within two columns of half the space the margin leaves over, and at least four
 * columns in, which is the smallest measured real indent (RFC 5155) and one more than the
 * three a diagram label or a change-log row starts at.
 *
 * `groupBlocks` supplies the last, structural-ordering condition and it is stated there:
 * RFC 9920 section 5 puts the title after the masthead, so this predicate is asked only of
 * the blocks that follow it. Both conditions are needed. Centring alone admits 155 blocks
 * in RFC 792's front matter - a 1 163-line packet-diagram legend whose field names,
 * `Version`, `IHL`, `Type of Service`, are single indented sentence-free lines - and ten
 * more single-line prose blocks in the front matter of RFC 792, RFC 854 and RFC 881,
 * whose whole documents are front matter because those typeset RFCs have no recognisable
 * heading until deep into the page.
 */
function isCentredTitleBlock(chunk: readonly Line[], sectionKind: SectionKind, margin: number | null): boolean {
  if (sectionKind !== "front_matter") return false;
  if (margin === null) return false;
  const values = chunk.map((line) => line.value).filter((value) => value.trim() !== "");
  if (values.length === 0) return false;
  const rightEdges = new Set<number>();
  for (const value of values) {
    if (!/^\s/u.test(value)) return false;
    if (/[|+]/u.test(value)) return false;
    if (UNDERLINE.test(value.trim())) return false;
    if (/ {3,}(?=\S)/u.test(value.trim())) return false;
    if (/[.!?]\s*$/u.test(value.trim())) return false;
    if (/^\s*(?:[-*•]|\(?[0-9a-zA-Z]{1,4}[.)])\s+\S/u.test(value)) return false;
    rightEdges.add(value.replace(/\s+$/u, "").length);
  }
  // A block whose lines all end at one column is right-aligned, which is the masthead's
  // signature, not a title's.
  if (values.length > 1 && rightEdges.size === 1) return false;
  const first = values[0]!;
  const left = indentWidth(first);
  const width = first.trim().length;
  if (left < 4) return false;
  if (Math.abs(left - (margin - width) / 2) > 2) return false;
  return values.some((value) => /\p{L}/u.test(value));
}

/**
 * Structural notation, decided without reference to how far the block is indented.
 *
 * A pipe table, a `+---+` rule, a CDDL or schema rule header, a block that is mostly one
 * quoted string, box drawing: none of those is a sentence at any column. RFC 5322's
 * field table sat at three columns of indent and was read as a paragraph for exactly
 * that reason, so the whole 2 697-character table entered the requirement list as one
 * row. Indent says where the typesetter put a block, not what the block is.
 */
function looksLikeNotation(chunk: readonly Line[]): boolean {
  const text = chunk
    .map((line) => line.value.trim())
    .filter((value) => value !== "")
    .join(" ");
  if (text === "") return true;
  // A header field block is two columns because the page is set in two columns, not
  // because the data is tabular. See `isMastheadHeaderBlock` for the test and for why
  // leaving it here made `coverage.completeness` unreachable for every document.
  if (isMastheadHeaderBlock(chunk)) return false;

  // A prose paragraph has pipes and internal alignment on a few lines at most; a table
  // has them on nearly all of them.
  const columnar = chunk.filter((line) => {
    const value = line.value;
    if (/^\s*\+[-=+]{3,}\+?\s*$/u.test(value)) return true;
    if (value.includes("|")) return true;
    if (/ {3,}\S/u.test(value.trim())) return true;
    return false;
  }).length;
  if (columnar / chunk.length > 0.4) return true;

  // CDDL, ABNF and schema blocks. RFC 9472's data model is 2 031 characters of rule
  // headers and quoted descriptions; it is a model, not a sentence.
  const ruleHeaders = chunk.filter((line) => /^\s*[\w.-]+(?:\s+[\w.-]+)*\s*=\s*[\[{]/u.test(line.value)).length;
  if (ruleHeaders / chunk.length > 0.25) return true;
  const quoted = (text.match(/"[^"]*"/gu) ?? []).join(" ").length;
  if (quoted / text.length > 0.35) return true;

  return /[┌┐└┘├┤─│]/u.test(text);
}

/**
 * Section kinds whose whole content is citation-shaped, so a bracket tag inside one is
 * evidence of a bibliography.
 */
const BIBLIOGRAPHY_SECTION_KINDS: ReadonlySet<SectionKind> = new Set(["references", "index", "authors"]);

/** A leading `[TAG]`, the shape RFC 2119 section 5 gives a reference entry. */
const CITATION_TAG = /^\s*\[\s*[A-Za-z0-9][A-Za-z0-9._-]*(?:\s*,\s*(?:Section|Appendix)[^\]]*)?\s*\]/u;

/**
 * A bracket tag is not a bibliography. It has to be followed by a citation.
 *
 * `classifyBlock` used to return `reference_entry` for any block whose first line opens
 * with `[...]`, in any section, and a tag at the start of a line is not evidence of
 * anything: RFC 4343 section 4.1's `[STD13] views the DNS namespace as a node tree.` and
 * RFC 9117 section 5's `[RFC8955] indicates that the originator may refer to ...` are
 * whole body paragraphs, quoted from another document, dropped before sentence splitting
 * by both passes. Measured over the 43-document measurement set, 144 blocks sat outside
 * any bibliography section; of those, 22 carry a modal in any case and not one yields a
 * requirement row, because the sentence is never read.
 *
 * So both conditions, and the first is "this part of the document is a bibliography".
 * The enclosing SECTION being typed `references` is one way to know that, and it is the
 * way the brief names, but on its own it is not enough: RFC 820's reference list and RFC
 * 1035's appendix of references both sit in sections the parser types `body`, because
 * those documents are typeset and have no recognisable contents, so a section-kind test
 * alone would have reclassified 132 GENUINE bibliography entries as prose. And prose is
 * the expensive direction: the strict extractor reads it.
 *
 * So the first condition is structural as well as nominal. A block belongs to a citation
 * list when the section it is in holds at least one OTHER block that also opens with a
 * citation tag - which is what a printed reference list looks like, including the shape
 * RFC 1035 uses where each entry is followed by a prose annotation block ("Obsolete. See
 * RFC-952.") and so no two tagged blocks are ever adjacent. A lone tagged block in a
 * section that has no other one is a sentence about a document, not the document: that
 * is the shape of all twelve measured cases X3 is about, including RFC 2068's `[rule]
 * Square brackets enclose optional elements` and RFC 1190's `[1.4] >>-> CONNECT B
 * -------->+--+`, which are a notation legend and a state-machine diagram.
 *
 * Citation shape, the second condition, is a document identifier - an RFC, BCP, STD or
 * Internet-Draft number, a DOI, an ISSN, a quoted title, or a four-digit year - somewhere
 * in the block, because a tag on its own names nothing.
 */
/**
 * The bibliographic record a citation entry is made of, as opposed to a sentence about
 * the cited document.
 *
 * A tag on its own names nothing, and a document identifier is not enough either, because
 * `[STD13]`, `[RFC8955]` and `[RFC1010]` are the same shape: a name and three digits with
 * no separator. What tells a reference entry from a quotation is what FOLLOWS the tag.
 * A reference entry is a record - an author (`Reynolds, J.`), a quoted title, an
 * organisation, a line that ends in a publication year - and a quotation of another
 * document in a body section is a sentence: `[STD13] views the DNS namespace as a node
 * tree.`, `[RFC8955] indicates that the originator may refer to ...`, `[RFC6437] suggests
 * deriving values using ...`, `[RFC2324] was an April 1 RFC that lampooned ...`. All four
 * name an RFC and all four are prose, and a test that only looked for the document number
 * would have called every one of them a bibliography.
 */
function looksLikeCitationEntry(chunk: readonly Line[]): boolean {
  if (!CITATION_TAG.test(chunk[0]!.value)) return false;
  const lines = chunk.map((line) => line.value);
  const text = lines.join("\n");
  // A quoted title, the commonest shape and the one RFC 2119 section 5 shows.
  if (/"[^"]{8,}"/u.test(text)) return true;
  // `Reynolds, J.` / `Petit-Huguenin, M.,` - a surname and an initial.
  if (/\b[A-Z][A-Za-z'-]+,\s+[A-Z]\./u.test(text)) return true;
  // An organisation in a record position: two or more capitalised words then a comma.
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s*,/u.test(text)) return true;
  // A line that ends in a publication year, which is where a reference entry ends.
  return lines.some((line) => /\b(?:19|20)\d{2}\)?\.?\s*$/u.test(line.trimEnd()));
}

function classifyBlock(
  chunk: readonly Line[],
  sectionKind: SectionKind,
  inCitationList: boolean,
  isTitle: boolean,
): BlockKind {
  const first = chunk[0]!.value;
  if ((BIBLIOGRAPHY_SECTION_KINDS.has(sectionKind) || inCitationList) && looksLikeCitationEntry(chunk)) {
    return "reference_entry";
  }
  if (isTitle) return "heading";
  if (/^\s*(?:[-*•]|\(?[0-9a-zA-Z]{1,4}[.)])\s+\S/u.test(first)) return "list_item";
  if (chunk.every((line) => /^\s*\|/.test(line.value) || line.value.trim() === "|")) return "table";
  const indents = chunk.map((line) => indentWidth(line.value));
  const minIndent = Math.min(...indents);
  // Notation is decided first and at any indent: a pipe table at three columns is still
  // a pipe table, and RFC 5322's field table spent its life in the requirement list as
  // one 2 697-character row because the old test only looked at blocks indented six
  // columns or more.
  if (looksLikeNotation(chunk)) {
    const allPipes = chunk.every((line) => /\|/.test(line.value) || / {2,}\S/u.test(line.value.trim()));
    return allPipes ? "table" : "preformatted";
  }
  if (minIndent >= 6) {
    // Indented, yes; prose, only if it is made of sentences. The old test answered the
    // first question with the second.
    return looksLikeProse(chunk) ? "paragraph" : "preformatted";
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

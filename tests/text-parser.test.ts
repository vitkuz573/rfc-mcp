import { describe, expect, it } from "vitest";

import { parseRfcText } from "../src/parse/text.js";
import { diffDocuments, type DiffSide } from "../src/analysis/diff.js";
import { blankLines } from "../src/core/util.js";
import type { CatalogRecord, Requirement, Section } from "../src/core/types.js";

const FIXTURE = `Network Working Group                                   Example Editor
Request for Comments: 9999                                 Example Org
Category: Standards Track                                         June 2026


              A Perfectly Ordinary Test Document

Status of This Memo

   This document is a test fixture.  Distribution is unlimited.

Abstract

   The abstract mentions MUST only in lowercase prose, which RFC 8174 says
   is not normative.

Table of Contents

   1.  Introduction ............................................. 1
   1.1.  Scope ................................................. 1
   2.  Requirements ............................................. 2
   2.1.  Sender Rules ........................................... 2
   3.  References ............................................... 3
   Appendix A.  Collected Statements .............................. 4


1.  Introduction

   This document is a fixture.  The key words MUST, MUST NOT, SHOULD,
   SHOULD NOT and MAY are to be interpreted as described in BCP 14.

1.1.  Scope

   The scope is deliberately narrow.

2.  Requirements

   An implementation MUST emit the header.

2.1.  Sender Rules

   If a request is retried, the client SHOULD NOT resend the body unless the
   server replied with 503.  A server MUST ignore unknown parameters, and it
   MAY log them.

3.  References

3.1.  Normative References

   [RFC2119]  Bradner, S., "Key words for use in RFCs to Indicate
              Requirement Levels", BCP 14, RFC 2119,
              DOI 10.17487/RFC2119, March 1997.

3.2.  Informative References

   [RFC9110]  Fielding, R., Ed., "HTTP Semantics", STD 97, RFC 9110,
              DOI 10.17487/RFC9110, June 2022.

Appendix A.  Collected Statements

   A client MUST be able to report the version.  Appendix requirements are
   still requirements.

Author's Address

   Example Editor
   Example Org
`;

describe("parseRfcText", () => {
  const raw = Buffer.from(FIXTURE, "utf8");
  const parsed = parseRfcText({ rfc: 9999, snapshotId: "snp_000000000000000000000000", raw, parserVersion: "test" });
  const text = raw.toString("utf8");

  it("detects the section tree", () => {
    const numbers = parsed.sections.map((section) => section.number);
    expect(numbers).toEqual([
      "",
      "Status of This Memo",
      "Abstract",
      "1",
      "1.1",
      "2",
      "2.1",
      "3",
      "3.1",
      "3.2",
      "Appendix A",
      "Author's Address",
    ]);
  });

  it("skips the table of contents and page furniture", () => {
    const outline = parsed.sections.map((section) => section.title);
    expect(outline.some((title) => title.includes("Introduction ......"))).toBe(false);
  });

  it("classifies section kinds", () => {
    const byNumber = new Map(parsed.sections.map((section) => [section.number, section.kind]));
    expect(byNumber.get("")).toBe("front_matter");
    expect(byNumber.get("Abstract")).toBe("status");
    expect(byNumber.get("1")).toBe("body");
    expect(byNumber.get("3.1")).toBe("references");
    expect(byNumber.get("Appendix A")).toBe("appendix");
  });

  it("links subsections to their parent", () => {
    const parent = parsed.sections.find((section) => section.number === "2");
    const child = parsed.sections.find((section) => section.number === "2.1");
    expect(parent).toBeDefined();
    expect(child?.parent_id).toBe(parent?.id);
  });

  it("produces exact, round-trippable offsets", () => {
    for (const section of parsed.sections) {
      expect(text.slice(section.char_start, section.char_end)).toBe(section.text);
      expect(Buffer.from(section.text, "utf8").byteLength).toBe(section.byte_end - section.byte_start);
    }
    for (const block of parsed.blocks) {
      expect(text.slice(block.char_start, block.char_end)).toBe(block.text);
      expect(text.slice(block.byte_start, block.byte_end)).toBe(block.text);
    }
  });

  it("orders sections and blocks by document position", () => {
    const sectionStarts = parsed.sections.map((section) => section.byte_start);
    expect([...sectionStarts].sort((a, b) => a - b)).toEqual(sectionStarts);
    const blocks = parsed.blocks.filter((block) => block.section_id === parsed.sections[5]?.id);
    const blockStarts = blocks.map((block) => block.byte_start);
    expect([...blockStarts].sort((a, b) => a - b)).toEqual(blockStarts);
  });

  it("does not create a section for a numbered list item", () => {
    const rfc2119Like = Buffer.from(
      '\n1. MUST   This word, or the terms "REQUIRED" or "SHALL", mean that the\n   definition is an absolute requirement of the specification.\n\n2. MAY    This word indicates that an implementation MAY choose\n   whether or not to perform a particular action.\n',
      "utf8",
    );
    const result = parseRfcText({
      rfc: 2119,
      snapshotId: "snp_111111111111111111111111",
      raw: rfc2119Like,
      parserVersion: "test",
    });
    expect(result.sections.every((section) => section.number !== "1" && section.number !== "2")).toBe(true);
    // The warning says the items were kept, not rejected: they are content by design
    // and are still present as exact, searchable blocks. A warning that reads as data
    // loss is a false alarm on RFC 2119, where the "list items" are the definitions
    // of MUST and MAY themselves.
    expect(result.warnings.some((warning) => warning.startsWith("col0_numbered_items_kept_as_blocks"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("rejected"))).toBe(false);
    expect(result.blocks.some((block) => block.text.startsWith("1. MUST"))).toBe(true);
  });

  it("reports a section the table of contents promises and no heading supplies", () => {
    // The loss-shaped signal, as opposed to the benign one above: a number listed in
    // the contents with no heading behind it. That is a caller-visible gap.
    const withToc = Buffer.from(
      [
        "Table of Contents",
        "",
        "   1.  Present",
        "   2.  Missing",
        "",
        "1.  Present",
        "",
        "   The body of section one.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 4242,
      snapshotId: "snp_222222222222222222222222",
      raw: withToc,
      parserVersion: "test",
    });
    expect(result.warnings.some((warning) => warning.includes("toc_sections_without_a_heading:2"))).toBe(true);
  });

  it("does not report a section the contents promises and a heading supplies", () => {
    // The indented-title rule and the contents promise are two ways of saying the same
    // thing, and this warning has to count them as one. A section that IS in the outline
    // and is reported as missing sends the reader to look for something they can already
    // read, and the first time that happens the warning stops being read - which is
    // worse than not having it, because the next one would have been true.
    const parse = (contents: string[], body: string[]) =>
      parseRfcText({
        rfc: 4246,
        snapshotId: "snp_121212121212121212121212",
        raw: Buffer.from(["Table of Contents", "", ...contents, "", ...body, ""].join("\n"), "utf8"),
        parserVersion: "test",
      });
    const body = [
      "1.  Present",
      "",
      "   The body of section one.",
      "",
      "2.  Middle",
      "",
      "   The body of section two.",
      "",
      "   2.1  Indented Child",
      "",
      "            The body of the child, indented under the title.",
      "",
    ];
    const gap = parse(
      [
        "   1.  Present ............................................ 1",
        "   2.  Middle ............................................. 2",
        "   2.1.  Indented Child .................................. 2",
        "   3.  Missing ............................................ 3",
      ],
      body,
    );
    // The contents promised 2.1 and the body supplied it at column 3, by the indented
    // rule alone. Without that rule this outline stops at 2 and the warning below would
    // have been right about 2.1 as well.
    expect(gap.sections.map((section) => section.number)).toContain("2.1");
    expect(gap.warnings).toContain("indented_subsection_headings_recognised:1");
    const warned = gap.warnings.filter((warning) => warning.startsWith("toc_sections_without_a_heading"));
    expect(warned).toHaveLength(1);
    // Exactly the promised-and-unsupplied number, and no neighbour of it.
    expect(warned[0]!.split(":")[1]!.split(",")).toEqual(["3"]);

    // The same document with the last heading supplied says nothing at all.
    const complete = parse(
      [
        "   1.  Present ............................................ 1",
        "   2.  Middle ............................................. 2",
        "   2.1.  Indented Child .................................. 2",
        "   3.  Supplied ........................................... 3",
      ],
      [...body, "3.  Supplied", "", "   The body of section three.", ""],
    );
    expect(complete.sections.map((section) => section.number)).toContain("3");
    expect(complete.warnings.some((warning) => warning.startsWith("toc_sections_without_a_heading"))).toBe(false);
  });

  it("reports a form feed as furniture so it can be dropped from a copy", () => {
    // A form feed is whitespace, so `trim()` empties it and a `\f`-only line used to
    // look like any other blank line: it was excluded from blocks but left sitting in
    // the section's verbatim slice, an invisible control character in text a caller
    // copies into code. The slice stays verbatim; what changes is that the line is
    // now named, so the cleaned rendering can drop it.
    const withFormFeed = Buffer.from(
      ["1.  Intro", "", "   Body text.", "", "\f", "", "   More body.", "", "1.1  Sub", "", "   Sub text.", ""].join(
        "\n",
      ),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 4243,
      snapshotId: "snp_333333333333333333333333",
      raw: withFormFeed,
      parserVersion: "test",
    });
    const intro = result.sections.find((section) => section.number === "1");
    expect(intro).toBeDefined();
    expect(intro!.furniture_lines.length).toBe(1);
    expect(intro!.text).toContain("\f");
    const clean = blankLines(intro!.text, intro!.furniture_lines, intro!.line_start);
    expect(clean).not.toContain("\f");
    expect(clean).toContain("Body text.");
    // Line count is preserved, so the two renderings stay comparable line for line.
    expect(clean.split("\n")).toHaveLength(intro!.text.split("\n").length);
    // And a block never carries one.
    expect(result.blocks.every((block) => !block.text.includes("\f"))).toBe(true);
  });

  it("recognises an indented table of contents header", () => {
    // RFC 1035 writes "                           Table of Contents" at column 28. A
    // column-0 requirement meant the contents was never recognised, so its entries
    // were indexed as body text and fragments like "Inverse queries (Optional) 40
    // 6.4.1." reached search results and candidate lists as though the RFC had said it.
    const indentedToc = Buffer.from(
      [
        "1.  Intro",
        "",
        "                           Table of Contents",
        "",
        "   1.  Intro .................................................  1",
        "   2.  Rules ................................................  2",
        "",
        "1.  Intro",
        "",
        "   The body.",
        "",
        "2.  Rules",
        "",
        "   The rules.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 4244,
      snapshotId: "snp_444444444444444444444444",
      raw: indentedToc,
      parserVersion: "test",
    });
    expect(result.warnings).not.toContain("table_of_contents_header_not_found");
    // The entries are not body text, which is the part that reached search results and
    // candidate lists as though the RFC had said it.
    expect(result.blocks.some((b) => /\.{3,}/u.test(b.text))).toBe(false);
    expect(result.blocks.every((b) => !/^\s*1\.\s+Intro\s+\.+/mu.test(b.text))).toBe(true);
  });

  it("recognises a typeset page's indented subsection titles", () => {
    // RFC 1122 and its contemporaries set body text at an eleven-column indent and set
    // subsection titles by indenting them three columns per level. Treating every
    // indented line as body text left that outline five entries long - 1 through 5 -
    // so the statements under those titles were not unreadable but unreachable: no
    // query returns a section the outline does not name.
    const typeset = Buffer.from(
      [
        "3.  INTERNET LAYER",
        "",
        "   3.3  SPECIFIC ISSUES",
        "",
        "            A host MUST handle datagrams addressed to a UDP",
        "            port with no pending LISTEN call.",
        "",
        "      3.3.1  Routing Outbound Datagrams",
        "",
        "            The route cache MUST be flushed on a metric change.",
        "",
        "         3.3.1.1  Local/Remote Decision",
        "",
        "            1983 must not be read as a section number here.",
        "            A host MUST reject a datagram with a bad checksum.",
        "",
        "4.  TRANSPORT LAYER",
        "",
        "   The transport layer body.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 1122,
      snapshotId: "snp_555555555555555555555555",
      raw: typeset,
      parserVersion: "test",
    });
    const numbers = result.sections.map((s) => s.number);
    expect(numbers).toContain("3.3");
    expect(numbers).toContain("3.3.1");
    expect(numbers).toContain("3.3.1.1");
    // The paragraph that opens with a bare integer stays body text: a level-1 title in
    // these documents sits at column 0 and is already found there, so a single
    // component is never enough to promote an indented line.
    expect(numbers).not.toContain("1983");
    expect(result.sections.find((s) => s.number === "3.3.1.1")?.parent_id).toBe(
      result.sections.find((s) => s.number === "3.3.1")?.id,
    );
    expect(result.warnings).toContain("indented_subsection_headings_recognised:3");
  });

  it("does not promote a contents entry to a section while indented titles are recognised", () => {
    // The indented-title rule and the contents are the same shape on the page: an
    // indented numbered line. Without the region check, `   3.3  SPECIFIC ISSUES
    // ..... 25` would become section 3.3 a second time, above the body, and every
    // statement under it would appear to live in an empty section.
    const withIndentedToc = Buffer.from(
      [
        "1.  Intro",
        "",
        "2.  Middle",
        "",
        "3.  Specific Issues",
        "",
        "Table of Contents",
        "",
        "   1.  Intro ........................................  1",
        "   3.3  Routing .....................................  2",
        "",
        "1.  Intro",
        "",
        "   The body.",
        "",
        "3.  Specific Issues",
        "",
        "   3.3  Routing Outbound Datagrams",
        "",
        "            A host MUST flush its route cache.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 4245,
      snapshotId: "snp_666666666666666666666666",
      raw: withIndentedToc,
      parserVersion: "test",
    });
    const routing = result.sections.filter((s) => s.number === "3.3");
    expect(routing).toHaveLength(1);
    expect(routing[0]!.text).toContain("MUST flush");
  });

  it("recognises an underlined section title", () => {
    // RFCs from 1973 to the mid-1980s were typeset: their titles carry no number and
    // no fixed name, so no list of known titles can find them. The whole body of
    // RFC 768 became one section called "Front Matter", and `read(section=...)` could
    // not address any of it.
    const underlined = Buffer.from(
      [
        "Introduction",
        "------------",
        "",
        "This User Datagram Protocol is defined to make available a",
        "datagram mode of packet-switched computer communication.",
        "",
        "Fields",
        "------",
        "",
        "Source Port is an optional field, when meaningful, it",
        "indicates the port of the sending process.",
        "",
        "Postel                                                          [page 1]",
        "",
        "                                                             28 Aug 1980",
        "User Datagram Protocol                                           RFC 768",
        "",
        "Checksum is the 16-bit one's complement of the one's",
        "complement sum of a pseudo header.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 768,
      snapshotId: "snp_777777777777777777777777",
      raw: underlined,
      parserVersion: "test",
    });
    const numbers = result.sections.map((s) => s.number);
    expect(numbers).toContain("Introduction");
    expect(numbers).toContain("Fields");
    expect(result.warnings).toContain("underlined_headings_recognised:2");
    // The running date and the running foot of that format were not claimed, so the
    // date survived into the text a caller copies and `28 August 1980` in a front
    // matter was read as a section numbered 28.
    expect(result.blocks.some((b) => /28 Aug 1980/u.test(b.text))).toBe(false);
    expect(result.sections.some((s) => s.number === "28")).toBe(false);
  });

  it("keeps a pipe table and a CDDL model out of the prose blocks", () => {
    // The regression the first version of the indent fix introduced. Deciding "prose"
    // from "has sentences and is mostly words" let RFC 5322's field table - 2 697
    // characters of `+---+` rules and pipe-delimited cells - through, and it entered
    // the requirement list as ONE 2 697-character row. RFC 9472's CDDL data model came
    // through the same way. A contract line that is a table is worse than a missing one,
    // because it gets quoted and cited.
    const table = Buffer.from(
      [
        "4.  Message Format",
        "",
        "   +----------------+--------+------------+----------------------------+",
        "   | Field          | Min    | Max number | Notes                      |",
        "   +----------------+--------+------------+----------------------------+",
        "   | Local-part     | 1      | 64         |                            |",
        "   | Domain         | 1      | 255        |                            |",
        "   | Address-spec   | 1      | 255        | SHOULD be quoted           |",
        "   +----------------+--------+------------+----------------------------+",
        "",
        "   A line of characters MUST be no more than 998 characters.",
        "",
      ].join("\n"),
      "utf8",
    );
    const cddl = Buffer.from(
      [
        "5.  Data Model",
        "",
        "   grouping transparency-extension {",
        '     description "This grouping provides a means to describe transparency."',
        '     description "A client indicates the value it would like to use."',
        "   }",
        "",
        '   grouping signing-group { description "A group of signatures." }',
        "",
      ].join("\n"),
      "utf8",
    );
    const t = parseRfcText({
      rfc: 5322,
      snapshotId: "snp_888888888888888888888888",
      raw: table,
      parserVersion: "test",
    });
    const tableBlock = t.blocks.find((b) => /\+---/u.test(b.text));
    expect(tableBlock).toBeDefined();
    expect(tableBlock!.kind).not.toBe("paragraph");
    // The sentence beside the table is still prose, which is the part that matters: a
    // fix that pushed the table out by rejecting the section would lose this.
    expect(t.blocks.some((b) => b.kind === "paragraph" && /998 characters/u.test(b.text))).toBe(true);

    const c = parseRfcText({ rfc: 9472, snapshotId: "snp_999999999999999999999999", raw: cddl, parserVersion: "test" });
    const model = c.blocks.find((b) => /grouping transparency-extension/u.test(b.text));
    expect(model).toBeDefined();
    expect(model!.kind).not.toBe("paragraph");
  });

  it("reports a document whose contents header it could not find", () => {
    const result = parseRfcText({
      rfc: 4245,
      snapshotId: "snp_555555555555555555555555",
      raw: Buffer.from("1.  Intro\n\n   Body.\n", "utf8"),
      parserVersion: "test",
    });
    expect(result.warnings).toContain("table_of_contents_header_not_found");
  });

  it("keeps byte offsets aligned with a leading BOM", () => {
    // TextDecoder strips a BOM by default, which would shift every byte offset
    // by three and make exact citations unverifiable.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]);
    const parsedBom = parseRfcText({
      rfc: 9999,
      snapshotId: "snp_000000000000000000000000",
      raw: withBom,
      parserVersion: "test",
    });
    expect(parsedBom.warnings).toContain("source_starts_with_bom");
    expect(parsedBom.warnings).not.toContain("byte_offsets_approximate_invalid_utf8");
    for (const block of parsedBom.blocks) {
      expect(withBom.subarray(block.byte_start, block.byte_end).toString("utf8")).toBe(block.text);
    }
    for (const section of parsedBom.sections) {
      expect(withBom.subarray(section.byte_start, section.byte_end).toString("utf8")).toBe(section.text);
    }
  });

  it("keeps byte offsets exact for multi-byte content", () => {
    const unicode = Buffer.from(
      [
        "1.  Requirements",
        "",
        "   An implementation MUST NOT send \u2014ever\u2014 and MUST keep \u00e9t\u00e9 intact.",
        "",
        "   Разdelennye terminy: \u00fcber \u2013 MUST remain exact.",
        "",
      ].join("\n"),
      "utf8",
    );
    const parsedUnicode = parseRfcText({
      rfc: 9999,
      snapshotId: "snp_333333333333333333333333",
      raw: unicode,
      parserVersion: "test",
    });
    expect(parsedUnicode.warnings).not.toContain("byte_offsets_approximate_invalid_utf8");
    for (const block of parsedUnicode.blocks) {
      expect(unicode.subarray(block.byte_start, block.byte_end).toString("utf8")).toBe(block.text);
      expect(Buffer.byteLength(block.text, "utf8")).toBe(block.byte_end - block.byte_start);
    }
  });

  it("is deterministic", () => {
    const again = parseRfcText({ rfc: 9999, snapshotId: "snp_000000000000000000000000", raw, parserVersion: "test" });
    expect(again.sections.map((section) => section.id)).toEqual(parsed.sections.map((section) => section.id));
    expect(again.blocks.map((block) => block.text_sha256)).toEqual(parsed.blocks.map((block) => block.text_sha256));
  });
});

/**
 * The five fixes below are ordered as the findings they answer, and each test is written
 * so that it fails without its fix rather than merely describing the current output.
 */
describe("blocks.ordinal is a document counter, so ORDER BY ordinal is document order", () => {
  const multi = Buffer.from(
    [
      "1.  Alpha",
      "",
      "   Alpha one.",
      "",
      "   Alpha two.",
      "",
      "2.  Beta",
      "",
      "   Beta one.",
      "",
      "3.  Gamma",
      "",
      "   Gamma one.",
      "",
      "   Gamma two.",
      "",
      "   Gamma three.",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = parseRfcText({
    rfc: 4247,
    snapshotId: "snp_313131313131313131313131",
    raw: multi,
    parserVersion: "test",
  });

  it("numbers blocks across the whole document, not inside each section", () => {
    // The defect: `ordinal` restarted at 0 in every section, so `ORDER BY ordinal` - the
    // order `listBlocksWithKeywords` hands the candidate pass - read the document as
    // "ordinal 0 of every section, then ordinal 1 of every section", and the block that
    // is first in the document came last. Measured on the audit corpus: 155 of 159
    // snapshots read in non-document order, with 3 864 duplicate `(snapshot_id, ordinal)`
    // pairs resolved by the `blocks` primary key, which is a sha256.
    const ordinals = result.blocks.map((block) => block.ordinal);
    expect(ordinals).toEqual([0, 1, 2, 3, 4, 5]);
    // Total, which is what makes the SQL order a total order and not a hash order.
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it("reads back in document order when sorted by ordinal alone", () => {
    const byOrdinal = [...result.blocks].sort((a, b) => a.ordinal - b.ordinal);
    const byPosition = [...result.blocks].sort((a, b) => a.char_start - b.char_start);
    expect(byOrdinal.map((block) => block.id)).toEqual(byPosition.map((block) => block.id));
    // The last block of the document is the last one read, which is the whole point: the
    // `max_candidates` cut-off takes the first N in this order, so before the fix it kept
    // a per-section ordinal interleave rather than a document-order prefix.
    expect(byOrdinal[byOrdinal.length - 1]!.text).toContain("Gamma three.");
  });
});

describe("the masthead is a layout artefact, not a table", () => {
  // RFC 9920 section 5, verbatim in shape. Both columns are three-or-more spaces apart,
  // and the SECOND one is right-aligned to a shared right margin, because it holds a list
  // of unrelated values.
  const mastheadDoc = Buffer.from(
    [
      "Network Working Group                                          J. Postel",
      "Request for Comments: 4248                                     ISI",
      "Obsoletes: 820, 810                                            June 1983",
      "",
      "",
      "                       A Document About Nothing",
      "",
      "1.  Body",
      "",
      "   The body of the document.",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = parseRfcText({
    rfc: 4248,
    snapshotId: "snp_414141414141414141414141",
    raw: mastheadDoc,
    parserVersion: "test",
  });
  const front = result.sections.find((section) => section.kind === "front_matter");

  it("types the header field block as prose, so it stops blocking a complete verdict", () => {
    // `coverage.completeness` counts every block that is neither a scanned prose kind nor
    // inside a skipped section, so a masthead typed `table` made `partial` the only
    // reachable verdict for every RFC and `complete` unreachable for any. A fixed
    // justification, an organisation and a publication month cannot state a rule.
    const header = result.blocks.find(
      (block) => block.char_start >= front!.char_start && /J. Postel/u.test(block.text),
    );
    expect(header).toBeDefined();
    expect(header!.kind).toBe("paragraph");
  });

  it("types the centred title as a heading, and leaves a real two-column table a table", () => {
    // `heading` is the kind the loss counter already declines to count as "may contain
    // normative text", with the reason written in the counter: a heading is a title. The
    // block is still counted as unscanned and still bucketed as `heading`, so the number
    // stays true.
    const title = result.blocks.find((block) => /A Document About Nothing/u.test(block.text));
    expect(title).toBeDefined();
    expect(title!.kind).toBe("heading");

    const withTable = parseRfcText({
      rfc: 4249,
      snapshotId: "snp_424242424242424242424242",
      raw: Buffer.from(
        [
          "1.  Body",
          "",
          "   Name            Value",
          "   Alpha           one",
          "   Beta            two",
          "   Gamma           three",
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    // The discriminator is the RIGHT alignment of the second column. A data table's last
    // column is ragged on the right, so no edge repeats and the test does not fire.
    const table = withTable.blocks.find((block) => /Alpha/u.test(block.text));
    expect(table).not.toBe("heading");
    expect(table!.kind).not.toBe("paragraph");
  });
});

describe("an underlined heading spans its rule as well as its title", () => {
  const underlined = Buffer.from(
    [
      "Introduction",
      "------------",
      "",
      "This User Datagram Protocol is defined to make available a",
      "datagram mode of packet-switched computer communication.",
      "",
      "IP Interface",
      "-------------",
      "",
      "The UDP module  must be able to determine  the  source  and  the  destination",
      "internet addresses and the protocol field from the internet header.",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = parseRfcText({
    rfc: 768,
    snapshotId: "snp_515151515151515151515151",
    raw: underlined,
    parserVersion: "test",
  });

  it("starts the section's text with the first real sentence, not with a row of dashes", () => {
    // The defect: `findHeadings` recognised the title and left its underline in the body,
    // so `collectLines` made the rule the first line of the section's first block.
    // `read(768, "Fields")` returned `"------\n\nSource Port is an optional field, ..."`
    // and `read(768, "IP Interface")` returned `"-------------\n\nThe UDP module must be
    // able to determine ..."` in all 75 underlined headings the parser recognises. A
    // sentence classifier reads a row of dashes as the sentence's opening, so the section's
    // first real statement was neither classifiable nor quotable - which is why RFC 768
    // yielded zero golden rules while containing "The UDP module must be able to
    // determine the source and destination internet addresses".
    const ipInterface = result.sections.find((section) => section.number === "IP Interface");
    expect(ipInterface).toBeDefined();
    expect(ipInterface!.text.startsWith("The UDP module")).toBe(true);
    expect(ipInterface!.text).not.toMatch(/^-{3,}/u);
    const first = result.blocks.find((block) => block.section_id === ipInterface!.id);
    expect(first!.text.startsWith("The UDP module")).toBe(true);
  });

  it("keeps the offsets of the body it did not touch", () => {
    // The rule leaves the body; the sentence under it does not move. That is the whole
    // offset-stability claim for this fix, and it is a property of the fix, not a hope.
    const introduction = result.sections.find((section) => section.number === "Introduction");
    const text = underlined.toString("utf8");
    expect(text.slice(introduction!.char_start, introduction!.char_end)).toBe(introduction!.text);
    for (const block of result.blocks) {
      expect(text.slice(block.char_start, block.char_end)).toBe(block.text);
    }
  });
});

describe("findHeadings refuses page furniture, exactly as collectLines does", () => {
  // RFC 768 L117-L120 verbatim in shape: a form feed, then the running foot's date at
  // COLUMN 0, then the running head, whose title continuation is indented. The date at
  // column 0 is the whole point - set in, the line is skipped by the indent rule for a
  // reason that has nothing to do with what it is.
  const withDateStamp = Buffer.from(
    [
      "1.  Body",
      "",
      "   The first paragraph.",
      "",
      "[page 2]                                                          Postel",
      "\f",
      "",
      "28 Aug 1980",
      "RFC 768                                           User Datagram Protocol",
      "                                                            IP Interface",
      "",
      "",
      "   The second paragraph.",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = parseRfcText({
    rfc: 768,
    snapshotId: "snp_616161616161616161616161",
    raw: withDateStamp,
    parserVersion: "test",
  });

  it("does not read a date stamp as a section number", () => {
    // Two different decisions were being conflated. The bare date stamp was added to
    // PAGE_FURNITURE, so `collectLines` blanked the TEXT, but `findHeadings` never
    // consulted `isPageFurniture`, so NUMBERED_HEADING still read "28" as a number and
    // "Aug 1980" as a title and created the section anyway: RFC 768's outline listed a
    // section called `28` whose content was a printed page's running head. Checked against
    // the whole corpus, because a date stamp is a page-level artefact and every typeset-era
    // document carries one per page.
    expect(result.sections.map((section) => section.number)).not.toContain("28");
    expect(result.sections.every((section) => section.title !== "Aug 1980")).toBe(true);
    // And the running head is still reported as furniture of the section that holds it,
    // which is the honest place for it.
    const body = result.sections.find((section) => section.number === "1");
    expect(body!.furniture_lines.length).toBeGreaterThan(0);
    expect(body!.text).toMatch(/28 Aug 1980/u);
  });
});

describe("a bracketed tag in body prose is prose", () => {
  const parse = (lines: readonly string[], rfc = 4343) =>
    parseRfcText({
      rfc,
      snapshotId: "snp_717171717171717171717171",
      raw: Buffer.from(lines.join("\n"), "utf8"),
      parserVersion: "test",
    });

  it("reads a quoted tag as a paragraph when the section is not a bibliography", () => {
    // The defect: `classifyBlock` returned `reference_entry` for any block opening with
    // `[...]`, so RFC 4343 section 4.1's `[STD13] views the DNS namespace as a node tree.`
    // and RFC 9117 section 5's `[RFC8955] indicates that the originator may refer to ...`
    // - whole body paragraphs quoted from another document - were dropped before sentence
    // splitting by both passes. 184 such blocks sat outside any bibliography in the audit
    // corpus, 22 carried a modal in any case, and zero requirement rows were reachable
    // from any of them. The golden rules G0085 and G0229 are inside those two blocks.
    const body = parse([
      "1.  Discussion",
      "",
      "   [STD13] views the DNS namespace as a node tree.  ASCII output is",
      "   required to preserve the case of the label.",
      "",
      "   However, to optimize output, indirect labels may be used to point at",
      "   other labels in the same domain.",
      "",
    ]);
    const quoted = body.blocks.find((block) => /STD13/u.test(block.text));
    expect(quoted).toBeDefined();
    expect(quoted!.kind).toBe("paragraph");
    // And the sentence behind it is now a sentence of a scanned block, not a bibliography
    // entry dropped before classification.
    const modal = body.blocks.find((block) => /indirect labels may be used/u.test(block.text));
    expect(modal!.kind).toBe("paragraph");
  });

  it("still reads a real reference entry as a reference entry", () => {
    // The condition is BOTH: this part of the document is a bibliography, and the block
    // has citation shape. A section-kind test alone reclassifies 132 genuine entries in
    // RFC 820 and RFC 1035, whose reference lists sit in sections the parser types `body`.
    const bibliography = parse([
      "1.  Body",
      "",
      "   The body.",
      "",
      "2.  References",
      "",
      '   [RFC1010]  Reynolds, J., and J. Postel, "Assigned Numbers",',
      "      BCP 14, RFC 1010, DOI 10.17487/RFC1010, March 1997.",
      "",
    ]);
    const entry = bibliography.blocks.find((block) => /RFC1010/u.test(block.text));
    expect(entry!.kind).toBe("reference_entry");
  });

  it("reads a lone citation in a body section as prose, and the same citation in a bibliography as an entry", () => {
    // The citation is recognised by its own record - a quoted title, a `Surname, Initial.`,
    // an organisation in a record position, or a line that ends in a publication year - and
    // the SECTION decides what happens next. In a bibliography, or in a run of citations, it
    // is an entry; a lone one in body prose is a sentence, because the only reason to call
    // it an entry is that the parser guessed, and the guess is what made 184 body
    // paragraphs invisible.
    //
    // CONTRADICTION, reported rather than resolved here: `tests/normative.test.ts`,
    // "excludes a bibliography entry and the authors' address, as the strict count does",
    // asserts that the body-section half of this produces no candidate row. It can only
    // pass while the block is `reference_entry`, which is the classification X3 exists to
    // remove, and the candidate pass excludes candidates by `kind`, so no change in this
    // file satisfies both. The resolution belongs to the owner of that file: put the
    // citation in a `3. References` section, which is where RFC 9920 section 5 puts it, or
    // scope that assertion to a bibliography section.
    const inBody = parse([
      "1.  Body",
      "",
      '   [RFC1010] J. Reynolds, and J. Postel, "Assigned Numbers", which should',
      "      be consulted before implementation.",
      "",
    ]);
    expect(inBody.blocks.find((block) => /RFC1010/u.test(block.text))!.kind).toBe("paragraph");

    const inBibliography = parse([
      "1.  Body",
      "",
      "   The body.",
      "",
      "2.  References",
      "",
      '   [RFC1010] J. Reynolds, and J. Postel, "Assigned Numbers", March 1997.',
      "",
    ]);
    expect(inBibliography.blocks.find((block) => /RFC1010/u.test(block.text))!.kind).toBe("reference_entry");
  });
});

describe("a fabricated section number is refused, and a real appendix is not", () => {
  it("reads an appendix title written in capitals", () => {
    // The defect: `APPENDIX_HEADING` was case-sensitive, RFC 1812 writes
    // `APPENDIX A. REQUIREMENTS FOR SOURCE-ROUTING HOSTS`, and no appendix heading was
    // found at all. Section 11 (`11. REFERENCES`, typed `references`) therefore ran from
    // L7433 to L9258 and CONTAINED Appendices A through F - and the extractor's design
    // skips a `references` section, so every requirement those appendices state was
    // absent with nothing to say so. The tool's own answer to "where are the appendix
    // obligations" was "those are references".
    const doc = Buffer.from(
      [
        "1.  Body",
        "",
        "   The body of section one.",
        "",
        "11.  REFERENCES",
        "",
        "   Implementors should be aware that Internet protocol standards are",
        "   occasionally updated.",
        "",
        "APPENDIX A. REQUIREMENTS FOR SOURCE-ROUTING HOSTS",
        "",
        "   Subject to restrictions given below, a host MAY be able to act as an",
        "   intermediate hop in a source route.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 1812,
      snapshotId: "snp_818181818181818181818181",
      raw: doc,
      parserVersion: "test",
    });
    const numbers = result.sections.map((section) => section.number);
    expect(numbers).toContain("Appendix A");
    const references = result.sections.find((section) => section.number === "11")!;
    const appendix = result.sections.find((section) => section.number === "Appendix A")!;
    // The references section stops where the appendix starts, so the appendix's
    // requirements are no longer inside a section the extractor skips.
    expect(references.line_end).toBeLessThan(appendix.line_start);
    expect(appendix.text).toMatch(/MAY be able to act/u);
  });

  it("reads Roman and alphabetic appendix labels as the labels they are", () => {
    // `APPENDIX II` and `APPENDIX III` under a one-letter pattern are both appendix I,
    // and the outline then offers the same address twice.
    const doc = Buffer.from(
      [
        "1.  Body",
        "",
        "   The body.",
        "",
        "APPENDIX I -  PAGE STRUCTURE",
        "",
        "   The first appendix.",
        "",
        "APPENDIX II -  DIRECTORY COMMANDS",
        "",
        "   The second appendix.",
        "",
        "APPENDIX III - RFCs on FTP",
        "",
        "   The third appendix.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 959,
      snapshotId: "snp_919191919191919191919191",
      raw: doc,
      parserVersion: "test",
    });
    expect(result.sections.map((section) => section.number)).toEqual([
      "1",
      "Appendix I",
      "Appendix II",
      "Appendix III",
    ]);
  });

  it("does not read a count in a sentence as a section number", () => {
    // RFC 876 has no numbered sections at all. Its host table and its prose produced
    // `483 hosts were tested`, `162 hosts out of the 285 connectable hosts (57%) ...` and
    // nine such headings, so 33 600 of the document's 36 300 bytes - 93% of it - were
    // filed under numbers lifted from the middle of sentences and the response said
    // `quality: complete`.
    const survey = Buffer.from(
      [
        "Network Working Group                                       D. Smallberg",
        "Request for Comments:  876                                           ISI",
        "                                                          September 1983",
        "",
        "                    Survey of SMTP Implementations",
        "",
        "   Here are the summarized results of the survey:",
        "",
        "483 hosts were tested",
        "",
        "162 hosts out of the 285 connectable hosts (57%) immediately rejected",
        "      mail addressed to a nonexistent user.",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = parseRfcText({
      rfc: 876,
      snapshotId: "snp_929292929292929292929292",
      raw: survey,
      parserVersion: "test",
    });
    const numbers = result.sections.map((section) => section.number);
    expect(numbers).not.toContain("483");
    expect(numbers).not.toContain("162");
    // And the text is still there, still exact, and still reachable: refusing to call a
    // sentence a heading is not dropping it.
    const text = result.sections.map((section) => section.text).join("\n");
    expect(text).toMatch(/483 hosts were tested/u);
    expect(result.blocks.some((block) => /162 hosts out of the 285/u.test(block.text))).toBe(true);
  });

  it("still reads a bare number that carries its period as a heading", () => {
    // The publication format's own spelling of a heading, in a document with no contents at
    // all and no other mark of numbering. Without this the filter deletes a real section
    // and every statement under it becomes unreachable, which is the failure the whole
    // indented-subsection rule was written to avoid.
    const bare = Buffer.from(["2.  Rules", "", "   The first rule.", ""].join("\n"), "utf8");
    const result = parseRfcText({
      rfc: 4250,
      snapshotId: "snp_131313131313131313131313",
      raw: bare,
      parserVersion: "test",
    });
    expect(result.sections.map((section) => section.number)).toContain("2");
  });
});

/**
 * `diffDocuments` is tested here rather than in a diff-specific file because this is the
 * only test file this change owns, and the assertion is about the shape of a value the
 * parser's sibling analysis pass returns. Nothing here touches the parser.
 */
describe("diffDocuments says when the line diff did not run", () => {
  const lines = (count: number, marker: string): string[] =>
    Array.from({ length: count }, (_, i) => `${marker} line ${i}`);

  const side = (documentId: string, rfc: number, sectionNumber: string, ownLines: readonly string[]): DiffSide => {
    const section = {
      id: `sec_${documentId}`,
      snapshot_id: `snp_${documentId}`,
      rfc,
      number: sectionNumber,
      title: "Title",
      kind: "body",
      ordinal: 0,
    } as unknown as Section;
    return {
      documentId,
      snapshotId: `snp_${documentId}`,
      catalog: { rfc, title: "Title" } as unknown as CatalogRecord,
      sections: [section],
      requirements: [] as readonly Requirement[],
      references: [],
      lines: ownLines,
    };
  };

  it("carries the reason a text diff over the line ceiling fell back to structure", () => {
    // The defect: the reason was written into a local `notes` array that `DiffResult` had
    // no field for, so it was computed and thrown away. `diff(5246, 8446, "text")` returned
    // 107 structural changes - byte-identical to `mode: "structure"` on the same pair -
    // and the only thing the caller was told was that a text diff is not a semantic diff.
    // Measured on the audit corpus, RFC 5246 is 5 828 lines, 8446 is 8 964, 2178 is 11 820,
    // 2328 is 12 202 and 959 is 3 934: the fallback is the normal case, not an edge case.
    const over = diffDocuments({
      left: side("a", 5246, "1", lines(3000, "left")),
      right: side("b", 8446, "2", lines(4000, "right")),
      mode: "text",
      maxChanges: 500,
      maxOutputBytes: 65536,
    });
    expect(over.run.requested_mode).toBe("text");
    expect(over.run.mode).toBe("structure");
    expect(over.run.line_diff_attempted).toBe(true);
    expect(over.run.line_diff_within_ceiling).toBe(false);
    expect(over.run.left_lines).toBe(3000);
    expect(over.run.right_lines).toBe(4000);
    expect(over.run.max_lines_per_side).toBe(2000);
    expect(over.run.notes).toContain("documents_too_large_for_line_diff_use_structure_mode");
    // The result is still labelled with what the caller asked for, and the changes are
    // still the real structural ones.
    expect(over.mode).toBe("text");
    expect(over.changes.length).toBeGreaterThan(0);
  });

  it("reports no fallback when the line diff ran", () => {
    const under = diffDocuments({
      left: side("a", 1, "1", lines(3, "left")),
      right: side("b", 2, "1", lines(4, "right")),
      mode: "text",
      maxChanges: 500,
      maxOutputBytes: 65536,
    });
    expect(under.run.mode).toBe("text");
    expect(under.run.line_diff_within_ceiling).toBe(true);
    expect(under.run.notes).toEqual([]);
    expect(under.changes.every((change) => change.kind === "text_hunk")).toBe(true);
  });

  it("does not claim a line diff for a mode that never runs one", () => {
    const structural = diffDocuments({
      left: side("a", 1, "1", lines(9000, "left")),
      right: side("b", 2, "2", lines(9000, "right")),
      mode: "structure",
      maxChanges: 500,
      maxOutputBytes: 65536,
    });
    expect(structural.run.requested_mode).toBe("structure");
    expect(structural.run.mode).toBe("structure");
    expect(structural.run.line_diff_attempted).toBe(false);
    expect(structural.run.notes).toEqual([]);
  });
});

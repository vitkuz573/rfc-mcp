import { describe, expect, it } from "vitest";

import { parseRfcText } from "../src/parse/text.js";
import { blankLines } from "../src/core/util.js";

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

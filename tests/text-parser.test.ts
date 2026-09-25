import { describe, expect, it } from "vitest";

import { parseRfcText } from "../src/parse/text.js";

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
    expect(result.warnings.some((warning) => warning.startsWith("col0_numbered_items_rejected"))).toBe(true);
    expect(result.quality).toBe("degraded");
    expect(result.blocks.some((block) => block.text.startsWith("1. MUST"))).toBe(true);
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

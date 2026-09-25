import { describe, expect, it } from "vitest";

import { analyzeNormative, splitSentences } from "../src/analysis/normative.js";
import { parseRfcText } from "../src/parse/text.js";
import type { Block, Section } from "../src/core/types.js";

const SNAPSHOT = "snp_222222222222222222222222";

function analyze(raw: string): {
  analysis: ReturnType<typeof analyzeNormative>;
  sections: readonly Section[];
  blocks: readonly Block[];
} {
  const parsed = parseRfcText({
    rfc: 9999,
    snapshotId: SNAPSHOT,
    raw: Buffer.from(raw, "utf8"),
    parserVersion: "test",
  });
  return {
    analysis: analyzeNormative({
      snapshotId: SNAPSHOT,
      rfc: 9999,
      sections: parsed.sections,
      blocks: parsed.blocks,
    }),
    sections: parsed.sections,
    blocks: parsed.blocks,
  };
}

describe("RFC 2119 / 8174 extraction", () => {
  it("splits sentences without breaking on abbreviations or initials", () => {
    const sentences = splitSentences("See RFC 2119, e.g. MUST. Next one follows. R. Fielding wrote it. Done.");
    expect(sentences.map((sentence) => sentence.text)).toEqual([
      "See RFC 2119, e.g. MUST.",
      "Next one follows.",
      "R. Fielding wrote it.",
      "Done.",
    ]);
  });

  it("detects all keywords with correct strength and polarity", () => {
    const { analysis } = analyze(
      [
        "2.  Requirements",
        "",
        "   An implementation MUST emit the header.",
        "",
        "   The client MUST NOT resend it.",
        "",
        "   A server SHOULD log it.",
        "",
        "   The server SHOULD NOT retry forever.",
        "",
        "   A client MAY cache it.",
        "",
        "   Support is REQUIRED for every deployment.",
        "",
        "   Caching is OPTIONAL for intermediaries.",
        "",
        "   Interop with RFC 2119 is NOT RECOMMENDED here.",
        "",
      ].join("\n"),
    );
    const terms = analysis.requirements.map(
      (requirement) => `${requirement.term}:${requirement.strength}:${requirement.polarity}`,
    );
    expect(terms).toContain("MUST:absolute:positive");
    expect(terms).toContain("MUST NOT:absolute:negative");
    expect(terms).toContain("SHOULD:recommendation:positive");
    expect(terms).toContain("SHOULD NOT:recommendation:negative");
    expect(terms).toContain("MAY:optional:positive");
    expect(terms).toContain("REQUIRED:absolute:positive");
    expect(terms).toContain("OPTIONAL:optional:positive");
    expect(terms).toContain("NOT RECOMMENDED:recommendation:negative");
  });

  it("never splits a negated phrase into a positive term plus NOT", () => {
    const { analysis } = analyze("2.  Rules\n\n   The client MUST NOT delete state.\n");
    const matches = analysis.mentions.filter((mention) => mention.exact_text.includes("MUST NOT"));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.term).toBe("MUST NOT");
    expect(matches[0]?.polarity).toBe("negative");
  });

  it("ignores lower case keywords per RFC 8174", () => {
    const { analysis } = analyze("2.  Rules\n\n   Implementations should do the thing.\n");
    expect(analysis.requirements).toHaveLength(0);
  });

  it("excludes preformatted blocks and code", () => {
    const { analysis, blocks } = analyze(
      ["2.  Rules", "", "   Example:", "", "      the client MUST send the header", "", "   Done.", ""].join("\n"),
    );
    expect(blocks.some((block) => block.kind === "preformatted")).toBe(true);
    expect(analysis.requirements).toHaveLength(0);
    expect(analysis.mentions).toHaveLength(0);
    expect(analysis.coverage.blocks_skipped).toBe(1);
  });

  it("marks keyword discussion as context, not requirement", () => {
    const { analysis } = analyze(
      [
        "7.  Security Considerations",
        "",
        "   The effects on security of not implementing a MUST or SHOULD may be subtle.",
        "",
        '   The key words "MUST" and "MUST NOT" are to be interpreted as described in BCP 14.',
        "",
      ].join("\n"),
    );
    expect(analysis.requirements).toHaveLength(0);
    expect(analysis.mentions.length).toBeGreaterThan(0);
    expect(analysis.mentions.every((mention) => mention.disposition === "definition")).toBe(true);
  });

  it("extracts the clause structure and flags a missing actor", () => {
    const { analysis } = analyze(
      [
        "2.  Rules",
        "",
        "   If a request is retried, the client SHOULD NOT resend the body except after a 503.",
        "",
        "   MUST be handled by the transport.",
        "",
      ].join("\n"),
    );
    const conditional = analysis.requirements.find((requirement) => requirement.term === "SHOULD NOT");
    expect(conditional?.clause.condition).toMatch(/If a request is retried/u);
    expect(conditional?.clause.actor).toBe("the client");
    expect(conditional?.clause.exception).toMatch(/except after a 503/u);
    expect(conditional?.parse_status).toBe("complete");

    const actorless = analysis.requirements.find(
      (requirement) => requirement.exact_text.trim() === "MUST be handled by the transport.",
    );
    expect(actorless?.clause.actor).toBeNull();
    expect(actorless?.flags).toContain("actor_not_explicit");
  });

  it("gives every requirement a stable, verifiable citation id", () => {
    const first = analyze("2.  Rules\n\n   An implementation MUST emit the header.\n");
    const second = analyze("2.  Rules\n\n   An implementation MUST emit the header.\n");
    expect(first.analysis.requirements[0]?.citation_id).toBe(second.analysis.requirements[0]?.citation_id);
    expect(first.analysis.requirements[0]?.citation_id).toMatch(/^cit_[0-9a-f]{24}$/u);
  });

  it("reports coverage instead of pretending completeness", () => {
    const { analysis } = analyze("2.  Rules\n\n   An implementation MUST emit the header.\n");
    expect(analysis.coverage.blocks_scanned).toBeGreaterThan(0);
    expect(analysis.coverage.mentions_found).toBe(1);
    expect(analysis.coverage.requirements_emitted).toBe(1);
  });
});

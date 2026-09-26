import { describe, expect, it } from "vitest";

import {
  analyzeNormative,
  analyzeNormativeCandidates,
  classifyRequirementShape,
  detectKeywordUsage,
  splitSentences,
} from "../src/analysis/normative.js";
import { parseRfcText } from "../src/parse/text.js";
import { blankLines } from "../src/core/util.js";
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

  it("drops a running head and a running foot as page furniture", () => {
    // RFC 1035 predates the plain-text format the RFC Editor now generates, so its
    // page breaks are a running head and a running foot rather than a bare marker.
    // Left in, they become a paragraph block of their own and split the field table.
    const raw = [
      "4.1.1.  Header Fields",
      "",
      "                                    1  1  1  1  1  1",
      "       +--+--+--+--+--+--+--+--+--+--+--+--+--+--+--+",
      "",
      "Mockapetris                                                    [Page 26]",
      "",
      "RFC 1035        Domain Implementation and Specification    November 1987",
      "",
      "   Z               Reserved for future use.  Must be zero in all queries.",
      "",
    ].join("\n");
    const { blocks } = analyze(raw);
    const withFurniture = blocks.filter((block) => /\[Page \d+\]|Domain Implementation/u.test(block.text));
    expect(withFurniture).toHaveLength(0);
    const field = blocks.find((block) => /Reserved for future use/u.test(block.text));
    // The block body stays a verbatim slice, indentation included, so its byte span
    // and its text remain the same range of the source.
    expect(field?.text).toBe("   Z               Reserved for future use.  Must be zero in all queries.");
  });

  it("keeps a body line that merely mentions a page number", () => {
    // The furniture patterns have to be narrow: dropping real text is worse than
    // leaving furniture in.
    const { blocks } = analyze(
      [
        "2.  Rules",
        "",
        "   See the discussion on page 26 of the original memo for",
        "   the full table of limits.",
        "",
      ].join("\n"),
    );
    expect(blocks.some((block) => /on page 26 of the original memo/u.test(block.text))).toBe(true);
  });

  it("records which section lines are furniture, so the exact text can be cleaned", () => {
    // `text` must stay a verbatim slice for its offsets to denote it, so the
    // furniture stays in it. The line numbers are what let a caller drop it.
    const { sections, blocks } = analyze(
      [
        "2.  Rules",
        "",
        "   The first rule.",
        "",
        "Mockapetris                                                    [Page 26]",
        "",
        "   The second rule.",
        "",
      ].join("\n"),
    );
    const body = sections.find((section) => section.number === "2");
    expect(body?.furniture_lines).toHaveLength(1);
    expect(body?.text).toMatch(/Mockapetris/u);
    const cleaned = blankLines(body!.text, body!.furniture_lines, body!.line_start);
    expect(cleaned).not.toMatch(/Mockapetris/u);
    expect(cleaned).toMatch(/The first rule\./u);
    // Line counts match, so the two renderings stay comparable line for line.
    expect(cleaned.split("\n")).toHaveLength(body!.text.split("\n").length);
    // And the blocks were already free of it.
    expect(blocks.every((block) => !/Mockapetris/u.test(block.text))).toBe(true);
  });

  it("reports coverage instead of pretending completeness", () => {
    const { analysis } = analyze("2.  Rules\n\n   An implementation MUST emit the header.\n");
    expect(analysis.coverage.blocks_scanned).toBeGreaterThan(0);
    expect(analysis.coverage.mentions_found).toBe(1);
    expect(analysis.coverage.requirements_emitted).toBe(1);
  });

  it("keeps a list marker out of the actor", () => {
    // RFC 6455-style list items reach the extractor with the marker still attached.
    // "o  Message fragments" is not a sentence the RFC says and not something an
    // implementer can act on.
    const { analysis } = analyze(
      [
        "2.  Rules",
        "",
        "   o  Message fragments MUST be delivered in order.",
        "",
        "   o  A sender MAY create fragments.",
        "",
      ].join("\n"),
    );
    expect(analysis.requirements).toHaveLength(2);
    for (const requirement of analysis.requirements) {
      expect(requirement.clause.actor).not.toMatch(/^o\b/u);
      expect(requirement.flags).toContain("list_marker_stripped_from_clause");
    }
    expect(analysis.requirements[0]?.clause.actor).toBe("Message fragments");
    expect(analysis.requirements[1]?.clause.actor).toBe("A sender");
  });

  it("collapses the hard-wrapped layout of a clause without changing its meaning", () => {
    const { analysis } = analyze(
      [
        "2.  Rules",
        "",
        "   A server that sends a 100 (Continue) response",
        "   MUST ultimately send a final status code.",
        "",
      ].join("\n"),
    );
    expect(analysis.requirements[0]?.clause.actor).toBe("A server that sends a 100 (Continue) response");
    expect(analysis.requirements[0]?.clause.action).toBe("ultimately send a final status code.");
  });
});

describe("non-strict normative candidates", () => {
  function candidates(raw: string): ReturnType<typeof analyzeNormativeCandidates> {
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(raw, "utf8"),
      parserVersion: "test",
    });
    return analyzeNormativeCandidates({
      snapshotId: SNAPSHOT,
      rfc: 9999,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
  }

  it("surfaces a title-case requirement the strict reading cannot promote", () => {
    // The RFC 1035 §4.1.1 header field table: binding on an implementer, but written
    // "Must", which RFC 8174 §3 gives no normative force.
    const analysis = candidates(
      [
        "4.1.1.  Header Fields",
        "",
        "   Z               Reserved for future use.  Must be zero in all",
        "                       queries and responses.",
        "",
      ].join("\n"),
    );
    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.candidates[0]?.keyword).toBe("Must");
    expect(analysis.candidates[0]?.keyword_case).toBe("title");
    expect(analysis.by_case.title).toBe(1);
  });

  it("surfaces a lower-case requirement with the reason it was skipped", () => {
    const analysis = candidates("2.  Rules\n\n   A name server must compare labels case-insensitively.\n");
    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.candidates[0]?.keyword_case).toBe("lower");
    // Capitalisation is the only reason here, so there is no structural cause.
    expect(analysis.candidates[0]?.reason).toBeNull();
    expect(analysis.by_keyword.must).toBe(1);
  });

  it("does not re-report what the strict extractor already owns", () => {
    const analysis = candidates("2.  Rules\n\n   An implementation MUST emit the header.\n");
    expect(analysis.candidates).toHaveLength(0);
  });

  it("reports candidates from blocks the strict extractor skips", () => {
    const analysis = candidates(
      ["2.  Rules", "", "   Example:", "", "      the resolver must set the AD bit", "", "   Done.", ""].join("\n"),
    );
    const nonProse = analysis.candidates.filter((candidate) => candidate.reason === "non_prose_block");
    expect(nonProse.length).toBeGreaterThan(0);
    // Both facts are reported: the block kind is the actionable one, the case the
    // one RFC 8174 speaks to.
    expect(nonProse[0]?.keyword_case).toBe("lower");
    expect(analysis.by_reason.non_prose_block).toBe(nonProse.length);
  });

  it("gives every candidate a verifiable citation id", () => {
    const analysis = candidates("2.  Rules\n\n   A name server must compare labels.\n");
    expect(analysis.candidates[0]?.citation_id).toMatch(/^cit_[0-9a-f]{24}$/u);
  });

  it("separates a modal keyword from an ordinary English one", () => {
    // The noise that makes a lead list unusable: "recommended" and "optional" are
    // also participles and adjectives, and "may" is also a plural noun.
    const analysis = candidates(
      [
        "2.  Rules",
        "",
        "   Name servers and resolvers must compare labels in a case-insensitive manner.",
        "",
        "   Mail is delivered using the recommended method for mail routing.",
        "",
        "   Recursive query support is an optional part of the DNS.",
        "",
        "   Many may object to this restriction.",
        "",
      ].join("\n"),
    );
    const byText = (fragment: string) => analysis.candidates.find((c) => c.exact_text.includes(fragment));
    expect(byText("must compare labels")?.role).toBe("modal");
    expect(byText("recommended method")?.role).toBe("non_modal");
    expect(byText("optional part")?.role).toBe("non_modal");
    expect(byText("Many may object")?.role).toBe("non_modal");
    expect(analysis.by_role.modal).toBe(1);
    expect(analysis.by_role.non_modal).toBe(3);
  });

  it("falls through to the structural test when the noise pattern does not match", () => {
    // `may` after a subject and before a verb is a modal, even though it is one of
    // the keywords a noun reading would also produce.
    const analysis = candidates("2.  Rules\n\n   A server may omit the 100 (Continue) response.\n");
    expect(analysis.candidates[0]?.role).toBe("modal");
  });

  it("does not call a sentence-final keyword a modal rule", () => {
    // Nothing follows the keyword, so there is no verb phrase for a modal to govern.
    const analysis = candidates("2.  Rules\n\n   The requirement applies to any implementation that may.\n");
    const candidate = analysis.candidates.find((c) => c.keyword === "may");
    expect(candidate?.role).toBe("non_modal");
  });

  it("never lets a role judgement change the requirement count", () => {
    const { analysis } = analyze("2.  Rules\n\n   Mail uses the recommended method for routing.\n");
    expect(analysis.requirements).toHaveLength(0);
  });

  it("reports a document that disclaims the requirement language", () => {
    // RFC 2181 opens with exactly this sentence, which is why its requirement count
    // is legitimately zero. The document says so; the response should too.
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "1.  Introduction",
          "",
          "   This memo does not use the oft used expressions MUST, SHOULD, MAY, or",
          "   their negative forms.",
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    const usage = detectKeywordUsage({ snapshotId: SNAPSHOT, blocks: parsed.blocks });
    expect(usage).toHaveLength(1);
    expect(usage[0]?.stance).toBe("disclaims");
    expect(usage[0]?.exact_text).toMatch(/does not use/u);
    expect(usage[0]?.citation_id).toMatch(/^cit_[0-9a-f]{24}$/u);
  });

  it("reports a document that adopts the requirement language", () => {
    // The opposite case: adoption makes a low count the surprising outcome.
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "1.  Introduction",
          "",
          '   The key words "MUST", "MUST NOT", "SHOULD" and "MAY" in this document',
          "   are to be interpreted as described in RFC 2119.",
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    const usage = detectKeywordUsage({ snapshotId: SNAPSHOT, blocks: parsed.blocks });
    expect(usage[0]?.stance).toBe("adopts");
  });

  it("does not invent a stance for a document that says nothing about it", () => {
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from("1.  Introduction\n\n   A server must retry.\n", "utf8"),
      parserVersion: "test",
    });
    expect(detectKeywordUsage({ snapshotId: SNAPSHOT, blocks: parsed.blocks })).toHaveLength(0);
  });

  it("applies the RFC 2119 section 3 action-verb test", () => {
    // The specification defines when a keyword has effect: rule 1 admits MUST only
    // "in a sentence that also contains an action verb". A clause without one cannot
    // be carrying a requirement, whatever its mood.
    const analysis = candidates(
      [
        "2.  Rules",
        "",
        "   Name servers and resolvers must compare labels in a case-insensitive manner.",
        "",
        "   Redesigned services may become available in the future.",
        "",
        "   This procedure should include:",
        "",
        "   A resolver may need to retry the query.",
        "",
      ].join("\n"),
    );
    const shape = (fragment: string) => analysis.candidates.find((c) => c.exact_text.includes(fragment))?.shape;
    expect(shape("must compare labels")).toBe("demand");
    // Grammatically modal, but no action verb: the specification's own test excludes it.
    expect(shape("Redesigned services may")).toBe("description");
    expect(shape("This procedure should include")).toBe("list_introducer");
    // Modal with an action verb, which is the shape a rule has.
    expect(shape("may need to retry")).toBe("demand");
    expect(analysis.by_shape.demand).toBe(2);
    expect(analysis.by_shape.description).toBe(1);
  });

  it("recognises the inflected verb forms the test depends on", () => {
    const cases: readonly [string, string][] = [
      ["A server must retry the query.", "demand"],
      ["A server must retries the query.", "demand"],
      ["A server must retried the query.", "demand"],
      ["A server must retrying the query.", "demand"],
      ["A server must cached the answer.", "demand"],
      ["The value is shown above.", "demand"],
      ["The table of contents.", "description"],
    ];
    for (const [clause, expected] of cases) {
      expect(classifyRequirementShape(clause), clause).toBe(expected);
    }
  });

  it("bounds the candidate list and says so", () => {
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "2.  Rules",
          "",
          ...Array.from({ length: 20 }, (_, _i) => {
            const i = _i;
            // Alternate the trailing punctuation so consecutive statements are not
            // read as one sentence spanning the page-break-shaped gaps.
            return `   Item ${i} must be handled${i % 2 === 0 ? "." : " and then some."}`;
          }),
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    const analysis = analyzeNormativeCandidates({
      snapshotId: SNAPSHOT,
      rfc: 9999,
      sections: parsed.sections,
      blocks: parsed.blocks,
      limit: 5,
    });
    expect(analysis.candidates).toHaveLength(5);
    expect(analysis.warnings).toContain("candidates_truncated_at_5");
  });

  it("splits sentences at a hard line break and not inside a wrapped one", () => {
    // The separator class was spaces and tabs only, so a period at the end of a line
    // never ended a sentence: twenty statements on twenty consecutive lines came back
    // as one. That is not cosmetic — `exact_text` is what a caller reads, and the
    // action-verb test scans the clause it is given, so a whole paragraph was always
    // classified `demand` whatever it said.
    const twenty = splitSentences(Array.from({ length: 20 }, (_, i) => `   Item ${i} must be handled.`).join("\n"));
    expect(twenty).toHaveLength(20);
    // A sentence that runs over a line break is still one sentence, and must quote as one.
    const wrapped = splitSentences(
      ["   Name servers and resolvers must compare labels in a case-insensitive", "   manner."].join("\n"),
    );
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.text).toContain("case-insensitive");
  });

  it("excludes a bibliography entry and the authors' address, as the strict count does", () => {
    // A citation containing "should" is not a requirement-shaped statement, and
    // promising they are excluded while sweeping them in is worse than not promising.
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "2.  Rules",
          "",
          "   A server must be deployed.",
          "",
          '   [RFC1010] J. Reynolds, and J. Postel, "Assigned Numbers", which should',
          "      be consulted before implementation.",
          "",
          "Author's Address",
          "",
          "   Implementors who may wish to comment should write to the IETF.",
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    const analysis = analyzeNormativeCandidates({
      snapshotId: SNAPSHOT,
      rfc: 9999,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    expect(analysis.candidates.some((c) => /Reynolds/u.test(c.exact_text))).toBe(false);
    expect(analysis.candidates.some((c) => /IETF/u.test(c.exact_text))).toBe(false);
    expect(analysis.warnings.some((w) => w.startsWith("reference_entry_blocks_skipped:"))).toBe(true);
  });

  it("emits one row per statement, not one per keyword", () => {
    // "must ... must NOT" in one sentence used to produce two rows for the same text,
    // filed under two different shapes, so filtering on shape could not say which row
    // described the real statement.
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        ["2.  Rules", "", "   A client must send the query and it must not be retransmitted more than twice.", ""].join(
          "\n",
        ),
        "utf8",
      ),
      parserVersion: "test",
    });
    const analysis = analyzeNormativeCandidates({
      snapshotId: SNAPSHOT,
      rfc: 9999,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    expect(analysis.candidates).toHaveLength(1);
    expect(analysis.candidates[0]?.keywords).toHaveLength(2);
    expect(analysis.candidates[0]?.keywords.map((k) => k.keyword)).toEqual(["must", "must not"]);
    // Each keyword keeps its own verdict, and the statement carries the first.
    expect(analysis.candidates[0]?.keywords[1]?.shape).toBe("demand");
    expect(analysis.candidates[0]?.shape).toBe("demand");
  });

  it("flags a sentence that a page break split in half", () => {
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "2.  Rules",
          "",
          "   Queries are exchanged as datagrams, though some transports",
          "",
          "Mockapetris                                                    [Page 26]",
          "",
          "RFC 9999        Test Document and Specification         January 1988",
          "",
          "   in this memo, and may be datagrams.",
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    const analysis = analyzeNormativeCandidates({
      snapshotId: SNAPSHOT,
      rfc: 9999,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    const fragment = analysis.candidates.find((c) => /and may be datagrams/u.test(c.exact_text));
    expect(fragment).toBeDefined();
    expect(fragment!.continues_previous_block).toBe(true);
    expect(analysis.warnings.some((w) => w.startsWith("sentences_split_across_a_page_break:"))).toBe(true);
  });
});

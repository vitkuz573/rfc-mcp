import { describe, expect, it } from "vitest";

import {
  analyzeNormative,
  analyzeNormativeCandidates,
  analyzeDeclarativeSpecifications,
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

  // A sentence can end inside a bracket or a quotation, and then the separator class
  // sits behind the closing character, so the boundary never fired. The row that came
  // out merged two statements, and the action-verb test reads the clause that follows
  // the keyword: a merged row cannot be classified, because the clause it is handed
  // carries the verb of the statement it swallowed. Both halves of the rule are
  // asserted here, because a one-sided fix is not a fix: the boundary has to see
  // through the closers and the veto has to see through them too.
  const CLOSER_CASES: readonly { label: string; text: string; want: readonly string[] }[] = [
    {
      label: "SPLITS - RFC 7719 sec 2, a sentence that ends inside a bracket",
      text: '(Note that this example might change in the future.) Note that the term "public suffix" is controversial in the DNS community for many reasons, and may be significantly changed in the future.',
      want: [
        "(Note that this example might change in the future.)",
        'Note that the term "public suffix" is controversial in the DNS community for many reasons, and may be significantly changed in the future.',
      ],
    },
    {
      label: "SPLITS - the full stop is inside the bracket, before the closer",
      text: "(See Section 2 for the details.) The next sentence follows here.",
      want: ["(See Section 2 for the details.)", "The next sentence follows here."],
    },
    {
      label: "SPLITS - a bracketed aside that ends the sentence",
      text: "The response has three parts (a request line, a header, and a body.) The next sentence follows.",
      want: ["The response has three parts (a request line, a header, and a body.)", "The next sentence follows."],
    },
    {
      label: "SPLITS - a full stop inside a square bracket",
      text: "The mode is octal (see [RFC 5321] for the list.) The next sentence follows.",
      want: ["The mode is octal (see [RFC 5321] for the list.)", "The next sentence follows."],
    },
    {
      label: "SPLITS - the full stop is inside the quotation",
      text: 'He called it "unregistered." The next sentence follows.',
      want: ['He called it "unregistered."', "The next sentence follows."],
    },
    {
      label: "SPLITS - a full stop after a digit is a boundary",
      text: "The limit is 512. The next sentence follows.",
      want: ["The limit is 512.", "The next sentence follows."],
    },
    {
      label: "SPLITS - a decimal number is not two sentence ends",
      text: "The value is 1.5. Next sentence.",
      want: ["The value is 1.5.", "Next sentence."],
    },
    {
      label: "SPLITS - a capital letter inside a list is not an initial",
      text: "Use one of the values (e.g. A, B). The next sentence follows.",
      want: ["Use one of the values (e.g. A, B).", "The next sentence follows."],
    },
    {
      label: "SPLITS - initials stay with the name they belong to",
      text: "(A. B. Smith wrote it.) The next sentence follows.",
      want: ["(A. B. Smith wrote it.)", "The next sentence follows."],
    },
    {
      label: "DOES NOT SPLIT - abbreviations and a capital initial",
      text: "See RFC 2119, e.g. MUST. Next one follows. R. Fielding wrote it. Done.",
      want: ["See RFC 2119, e.g. MUST.", "Next one follows.", "R. Fielding wrote it.", "Done."],
    },
    {
      label: "DOES NOT SPLIT - figure and section abbreviations",
      text: "See Fig. 3 and Sec. 4.5 for the details.",
      want: ["See Fig. 3 and Sec. 4.5 for the details."],
    },
    {
      label: "DOES NOT SPLIT - two names joined by and",
      text: "See J. Reynolds, and K. Postel, for the numbers.",
      want: ["See J. Reynolds, and K. Postel, for the numbers."],
    },
    {
      label: "DOES NOT SPLIT - an ellipsis is not a sentence end",
      text: "The options are A, B, or C ... . The next sentence follows.",
      want: ["The options are A, B, or C ... . The next sentence follows."],
    },
    {
      label: "DOES NOT SPLIT - an ellipsis spaced out is not a sentence end either",
      text: "The options are A, B, or C . . . The next sentence follows.",
      want: ["The options are A, B, or C . . . The next sentence follows."],
    },
    {
      label: "DOES NOT SPLIT - a sentence that wraps across a line break",
      text: "A server that sends a 100 (Continue) response\n   must ultimately send a final status code.",
      want: ["A server that sends a 100 (Continue) response\n   must ultimately send a final status code."],
    },
  ];

  it.each(CLOSER_CASES)("$label", ({ text, want }) => {
    expect(splitSentences(text).map((sentence) => sentence.text)).toEqual(want);
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

  it("still finds every keyword after a document whose blocks were skipped", () => {
    // A global regex is stateful, and `String.prototype.matchAll` copies its `lastIndex`
    // into the clone it walks. So one boolean test of the shared keyword pattern moves
    // the starting point of every later sentence scan in the same process. The loss
    // counter did exactly that, and the symptom was two tests in this file that passed
    // alone and failed together - the only shape this bug has, and the reason it
    // survived five review rounds nobody could reproduce.
    //
    // The first document here is the trigger: its rules live in a table, so the strict
    // pass skips the block and asks the shared pattern a yes/no question about it. The
    // second document's requirements are only found if that question left no trace.
    const skipped = analyze(
      [
        "2.  Rules",
        "",
        "   +----------------+--------+",
        "   | Field          | MUST   |",
        "   +----------------+--------+",
        "",
      ].join("\n"),
    );
    expect(skipped.analysis.coverage.blocks_skipped).toBeGreaterThan(0);

    const after = analyze(["3.  More", "", "   An implementation MUST emit the header.", ""].join("\n"));
    expect(after.analysis.requirements).toHaveLength(1);
    expect(after.analysis.requirements[0]?.exact_text).toBe("An implementation MUST emit the header.");
    // And the loss counter is what the trigger was for: the table holds a keyword and is
    // out of scope, and the response says so rather than leaving the caller to guess.
    expect(skipped.analysis.coverage.keyword_bearing_blocks_skipped).toBeGreaterThan(0);
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

  // `shape` is the only field a caller can filter on to find the rows that can state
  // an obligation, so a descriptive modal filed `demand` is a rule in a compliance
  // contract that the RFC never wrote. In a hand-checked sample of 190 candidate rows,
  // 35 of the 120 false positives were exactly that, and every one of them scanned as
  // `demand` on the verb lexicon alone: the lexicon asks whether the clause holds a
  // verb, and "should offer", "may transmit" and "should use" all do.
  //
  // The helper below computes the three arguments exactly as `analyzeNormativeCandidates`
  // does - the clause the keyword governs, and where the keyword sits in the statement -
  // because the subject and any predicate the sentence has already spent are both
  // behind the keyword, and a clause on its own cannot show them.
  const shapeOf = (sentence: string, keyword: string): string => {
    const keywordIndex = sentence.toLowerCase().indexOf(keyword);
    const governed = sentence
      .slice(keywordIndex + keyword.length)
      .split(";")[0]!
      .trim();
    return classifyRequirementShape(governed, keyword, { sentence, keywordIndex });
  };

  const SHAPE_SIDES: readonly {
    label: string;
    text: string;
    keyword: string;
    want: "demand" | "description" | "indeterminate";
  }[] = [
    {
      label: "NOT an obligation - the modal is the predicate of a relative clause inside a reported cause",
      text: "These shortcomings arise from lack of clarity about which DH group parameters TLS servers should offer and clients should accept.",
      keyword: "should",
      want: "description",
    },
    {
      label: "NOT an obligation - the sentence reports a claim attributed to a citation",
      text: "Without knowledge of the MTU for an LSP, edge LSRs may transmit packets along that LSP which are, according to [4], too big.",
      keyword: "may",
      want: "description",
    },
    {
      label: "NOT an obligation - the modal governs a gerund, an activity rather than an actor",
      text: "Deploying DNSSEC in such an environment may present some challenges, depending on the configuration and feature set in use.",
      keyword: "may",
      want: "description",
    },
    {
      label: "NOT an obligation - the addressed party is the authors of specifications, not an implementor",
      text: 'Future specifications and related documentation should use the general term "URI" rather than the more restrictive terms "URL" and "URN".',
      keyword: "should",
      want: "description",
    },
    {
      label: "NOT an obligation - the modal evaluates the situation instead of specifying a value",
      text: "In general this should not be a problem.",
      keyword: "should",
      want: "description",
    },
    {
      label: "NOT an obligation - the row is two statements, and the verb answering it is the second one's",
      // After the splitter fix this sentence is its own row and holds no keyword, so it
      // never reaches the classifier. The shape is asserted on the merged row it used to
      // be, because that is the only shape in which it was ever a false positive.
      text: "A future specification should name the author. Unfortunately, he became ill and eventually passed away in May 2022 without being able to complete the document.",
      keyword: "should",
      want: "indeterminate",
    },
    {
      label: "NOT an obligation - the keyword is a modifier inside a noun phrase",
      text: "The recommended method for mail routing is the one below.",
      keyword: "recommended",
      want: "description",
    },
    {
      label: "NOT an obligation - the modal is the predicate of a complement clause",
      text: "The difficulty is that a server should be restarted more often than the timer allows.",
      keyword: "should",
      want: "description",
    },
    {
      label: "NOT an obligation - the modal is inside a parenthesised attribution to another document",
      text: "A resolver may answer from its cache, according to [RFC 2181], before the query expires.",
      keyword: "may",
      want: "description",
    },
    {
      label: "IS an obligation - an explicit actor and a prohibited action",
      text: "Routers SHOULD NOT place this option in a datagram that the router originates.",
      keyword: "should not",
      want: "demand",
    },
    {
      label: "IS an obligation - an explicit actor and a base-form action verb",
      text: "The server MUST ignore this value.",
      keyword: "must",
      want: "demand",
    },
    {
      label: "IS an obligation - an actor, a base form and a relative clause after it",
      text: "Implementations MUST have behavior that is indistinguishable from following the algorithms.",
      keyword: "must",
      want: "demand",
    },
    {
      label: "IS an obligation - a permission stated with a copula",
      text: "A server MAY be used to retrieve a zone by AXFR.",
      keyword: "may",
      want: "demand",
    },
    {
      label: "IS an obligation - a permission stated with a plain action verb",
      text: "Origin servers MAY send a Set-Cookie response header with any response.",
      keyword: "may",
      want: "demand",
    },
    {
      label: "IS an obligation - the same courtesy frame, but the predicate specifies a value",
      text: "In general this should be the default value for the field.",
      keyword: "should",
      want: "demand",
    },
    {
      label: "IS an obligation - the same activity frame, but the subject is a noun",
      text: "Such an environment may present some challenges.",
      keyword: "may",
      want: "demand",
    },
    {
      label: "IS an obligation - the citation is the authority for the rule, not the source of a report",
      text: "The TTL MUST be set according to [RFC 2181].",
      keyword: "must",
      want: "demand",
    },
    {
      label: "IS an obligation - the subject's own relative clause spends its verb before the modal",
      text: "A server that receives a 100 (Continue) response MUST ultimately send a final status code.",
      keyword: "must",
      want: "demand",
    },
  ];

  it.each(SHAPE_SIDES)("$label", ({ text, keyword, want }) => {
    expect(shapeOf(text, keyword)).toBe(want);
  });

  it("decides the shape of a candidate from the statement, not from the clause alone", () => {
    // The wiring, end to end. Both rows are lower-case on purpose: a document that
    // predates RFC 2119 states its rules that way, and an upper-case keyword in a prose
    // block belongs to the strict extractor, which is what owns it.
    const analysis = candidates(
      [
        "2.  Rules",
        "",
        "   The recommended method for mail routing is the one below.",
        "",
        "   Name servers and resolvers must compare labels in a case-insensitive",
        "   manner.",
        "",
      ].join("\n"),
    );
    const shape = (fragment: string) => analysis.candidates.find((c) => c.exact_text.includes(fragment))?.shape;
    expect(shape("recommended method")).toBe("description");
    // The relative clause in the subject is not the clause the modal is in: "receive"
    // is spent before it, and the modal is the predicate of the statement itself.
    expect(shape("must compare labels")).toBe("demand");
    expect(analysis.by_shape.demand).toBe(1);
    expect(analysis.by_shape.description).toBe(1);
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
    //
    // The citation is in a References section here, which is where RFC 9920 §5 puts it and
    // where the exclusion applies. An earlier version of this fixture put the citation in a
    // body section and asserted the same outcome, which could only hold while a block
    // opening with a bracketed tag was typed `reference_entry` wherever it appeared - the
    // classification that made 184 body paragraphs across 45 documents unreadable, RFC
    // 4343's `[STD13]` quotation and RFC 9117's `[RFC8955]` paragraph among them. A tag at
    // the start of a line is not evidence of a bibliography, so the assertion moved to
    // where the rule actually applies. The body-section case is asserted separately below,
    // with the outcome it now has, because a changed behaviour nobody asserted is a
    // behaviour nobody is watching.
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "2.  Rules",
          "",
          "   A server must be deployed.",
          "",
          "3.  References",
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
    // The exclusion is counted, under whichever key names it. A section of kind
    // `references` or `authors` is skipped as a whole, so the count arrives as
    // `candidate_sections_skipped:` rather than as a per-kind block bucket; pinning the
    // key would assert an implementation detail and lose the promise the comment makes,
    // which is that a filter nobody can see is indistinguishable from a filter that hides
    // a miss.
    expect(
      analysis.warnings.some(
        (w) =>
          w.startsWith("reference_entry_blocks_skipped:") ||
          w.startsWith("candidate_sections_skipped:") ||
          w.startsWith("section:references_blocks_skipped:"),
      ),
    ).toBe(true);
  });

  it("reads a citation-shaped block in a body section as prose, so its text is reachable", () => {
    // The counterpart of the test above, and the reason the exclusion is bounded rather
    // than removed. RFC 4343 §4.1 and RFC 9117 §5 are quoted material opening with a
    // bracketed tag at the same indent as the prose around it; both carry obligations that
    // were in no channel at all. Reaching them as CANDIDATES is the point - they are
    // somebody else's words, and a caller decides what to do with quoted material, which a
    // silently dropped paragraph does not let them do.
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "2.  Rules",
          "",
          "   [STD13] views the DNS namespace as a node tree. To optimize output,",
          "      indirect labels may be used to point to names elsewhere in the answer.",
          "",
          "   [RFC8955] indicates that a network should be designed so it has a",
          "      congruent topology amongst unicast and Flow Specification routes.",
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
    const texts = analysis.candidates.map((c) => c.exact_text);
    expect(texts.some((t) => /indirect labels may be used/u.test(t))).toBe(true);
    expect(texts.some((t) => /should be designed so it has/u.test(t))).toBe(true);
    // And it is not promoted: the strict pass does not own quoted material.
    const strict = analyzeNormative({
      snapshotId: SNAPSHOT,
      rfc: 9999,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    expect(strict.requirements.some((r) => /indirect labels may be used/u.test(r.exact_text))).toBe(false);
  });

  it("excludes the fixed texts the RFC Editor prints around every document", () => {
    // In a 190-item hand-checked sample of a candidate list, these two sentences were
    // 46 rows - a quarter of the list a reader of a pre-2119 document depends on.
    // Neither says anything about the protocol: one is a pointer to the RFC Editor's
    // info page, the other a BCP-13 licence notice about redistributing the document.
    // The exclusion is counted, because a filter nobody can see is indistinguishable
    // from a filter that hides a miss.
    const parsed = parseRfcText({
      rfc: 9110,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "1.  Intro",
          "",
          "   A sender must not generate an element the grammar forbids.",
          "",
          "   Information about the current status of this document, any errata, and how",
          "   to provide feedback on it may be obtained at http://www.rfc-editor.org/info/rfc9110.",
          "",
          "   Code Components extracted from this document must include Simplified BSD",
          "   License text as described in Section 4.e of the Trust Legal Provisions.",
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    const analysis = analyzeNormativeCandidates({
      snapshotId: SNAPSHOT,
      rfc: 9110,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    const texts = analysis.candidates.map((c) => c.exact_text);
    expect(texts.some((t) => /current status of this document/u.test(t))).toBe(false);
    expect(texts.some((t) => /Code Components extracted/u.test(t))).toBe(false);
    // The obligation in the same document survives, so the filter is not a section-wide
    // skip dressed up as a sentence filter.
    expect(texts.some((t) => /grammar forbids/u.test(t))).toBe(true);
    expect(analysis.warnings.some((w) => w.startsWith("boilerplate_statements_excluded:2"))).toBe(true);
  });

  it("reads an indented paragraph as prose, and notation as notation", () => {
    // The single largest recall defect the bench found. `classifyBlock` called every
    // chunk with a six-column indent preformatted, and RFCs from 1973 to the mid-1990s
    // indent their BODY TEXT: RFC 1122 sets every paragraph at column 12. RFC 1122 then
    // reported 17 requirements while its own candidate list held 255 upper-case
    // modal-and-demand statements from the same text. A paragraph is prose whatever
    // column it starts in; what marks notation is the absence of sentences.
    const parsed = parseRfcText({
      rfc: 1122,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(
        [
          "3.  INTERNET LAYER",
          "",
          "   3.3  SPECIFIC ISSUES",
          "",
          "            A host MUST silently discard a datagram addressed to a UDP",
          "            port for which there is no pending LISTEN call.",
          "",
          "                RECV_ICMP(BufPTR ) -> result, src, dst, len, opt",
          "",
          "                o Destination Unreachable",
          "",
        ].join("\n"),
        "utf8",
      ),
      parserVersion: "test",
    });
    const prose = parsed.blocks.filter((b) => /silently discard/u.test(b.text));
    expect(prose).toHaveLength(1);
    expect(prose[0]!.kind).toBe("paragraph");
    const notation = parsed.blocks.filter((b) => /RECV_ICMP/u.test(b.text));
    expect(notation).toHaveLength(1);
    expect(notation[0]!.kind).toBe("preformatted");
    // And the sentence in the paragraph is now reachable by the strict extractor, which
    // is the whole point: it was `non_prose_block` in the candidate list before.
    const analysis = analyzeNormative({
      snapshotId: SNAPSHOT,
      rfc: 1122,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    expect(analysis.requirements.some((r) => /silently discard/u.test(r.exact_text))).toBe(true);
  });

  it("emits one requirement per statement, and keeps every keyword on it", () => {
    // The candidate list was fixed to one row per statement in an earlier round; the
    // strict list was not, so a sentence with three keywords came back three times and
    // `coverage.total_requirements` - a number callers build a contract on - counted one
    // sentence as three requirements. 1 411 of 11 640 strict rows corpus-wide were a
    // repeat of a sentence already in the same list.
    const { analysis } = analyze(
      [
        "2.  Rules",
        "",
        "   EMTU_R MUST be greater than or equal to 576, SHOULD be either configurable or",
        "   indefinite, and SHOULD be greater than or equal to the MTU of the connection.",
        "",
      ].join("\n"),
    );
    const rows = analysis.requirements.filter((r) => /EMTU_R/u.test(r.exact_text));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exact_text).toContain("indefinite");
    // Nothing is lost: the other two keywords are on the row with their own polarity and
    // offsets, so "does this statement contain a SHOULD" is still answerable.
    expect(rows[0]!.keywords.map((k) => k.term)).toEqual(["MUST", "SHOULD", "SHOULD"]);
    expect(rows[0]!.term).toBe("MUST");
    expect(rows[0]!.flags).toContain("keywords_collapsed_to_one_row");
    // The span is the statement, not four letters of it: a citation over this row has to
    // verify what a caller would quote from it.
    expect(rows[0]!.span.char_end - rows[0]!.span.char_start).toBeGreaterThan(80);
    // Mentions stay per occurrence - that is what a mention is.
    expect(analysis.mentions.filter((m) => /EMTU_R/u.test(m.exact_text))).toHaveLength(3);
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

describe("declarative specifications (no RFC 2119 keyword at all)", () => {
  // RFC 8174 section 2, which is RFC 2119 as corrected, says of the eleven words:
  // "normative text does not require the use of these key words. They are used for
  // clarity and consistency when that's what's wanted, but a lot of normative text does
  // not use them and is still normative." On a 100-protocol golden set, 13 statements
  // that bind an implementor without a modal were found by hand and none of them was
  // reachable: `analyzeNormative` reads only sentences that carry a keyword, and the
  // service hands `analyzeNormativeCandidates` only blocks that do.
  const KEYWORD_FREE = [
    "2.  Limits",
    "",
    "   The maximum total length of a command line including the command word and the",
    "   <CRLF> is 512 octets.",
    "",
    "   This media type restricts the maximum size of the DNS message to 65535 bytes.",
    "",
    "   The 998 character limit is due to limitations in many implementations that send,",
    "   receive, or store messages which cannot handle more than 998 characters on a line.",
    "",
  ].join("\n");

  function parse(raw: string) {
    const parsed = parseRfcText({
      rfc: 5321,
      snapshotId: SNAPSHOT,
      raw: Buffer.from(raw, "utf8"),
      parserVersion: "test",
    });
    return { snapshotId: SNAPSHOT, rfc: 5321, sections: parsed.sections, blocks: parsed.blocks };
  }

  function both(raw: string, declarativeLimit?: number) {
    const args = parse(raw);
    return {
      strict: analyzeNormative(args),
      candidates: analyzeNormativeCandidates({
        ...args,
        ...(declarativeLimit !== undefined ? { declarativeLimit } : {}),
      }),
    };
  }

  it("reaches a specification that states no modal at all", () => {
    const { candidates } = both(KEYWORD_FREE);
    const texts = candidates.declarative_specifications.map((row) => row.exact_text);
    expect(texts.some((t) => /command line including the command word/u.test(t))).toBe(true);
    expect(texts.some((t) => /maximum size of the DNS message to 65535 bytes/u.test(t))).toBe(true);
    expect(texts.some((t) => /998 character limit/u.test(t))).toBe(true);
    // The published test that decided each row is on the row, so a caller can see how
    // much of the list each test decided instead of having to trust the whole of it.
    expect(candidates.declarative_by_basis["numeric-bound"]).toBe(3);
    for (const row of candidates.declarative_specifications) {
      expect(row.citation_id).toMatch(/^cit_[0-9a-f]{24}$/u);
      expect(row.span.char_end - row.span.char_start).toBe(row.exact_text.length);
    }
  });

  it("carries no keyword, no case and no polarity, because the sentence has none", () => {
    // A row with a keyword field would be counted by anything that filters on one, and
    // the entire point of this list is that it is not a requirements list. RFC 8174
    // section 3 gives a keyword-free statement no force, and nothing here may pretend
    // otherwise.
    const { candidates } = both(KEYWORD_FREE);
    const row = candidates.declarative_specifications[0]!;
    expect(Object.keys(row).sort()).toEqual([
      "basis",
      "block_id",
      "char_start",
      "citation_id",
      "exact_text",
      "id",
      "rfc",
      "section_id",
      "snapshot_id",
      "span",
    ]);
    for (const invented of ["keyword", "keyword_case", "polarity", "strength", "role", "shape", "reason"]) {
      expect(row, invented).not.toHaveProperty(invented);
    }
  });

  it("never reaches the requirement count, with or without include_provisional", () => {
    // The whole point of RFC 8174 section 3 is that a number a caller trusts must not
    // absorb rows that carry no keyword. `include_provisional` appends `candidates` to
    // `requirements` under an explicit flag, so a declarative row that is not a
    // candidate cannot be appended by it either.
    const raw = [
      "2.  Limits",
      "",
      "   The maximum total length of a command line is 512 octets.",
      "",
      "   A server MUST reject any longer line.",
      "",
    ].join("\n");
    const { strict, candidates } = both(raw);
    expect(strict.requirements).toHaveLength(1);
    expect(strict.coverage.requirements_emitted).toBe(1);
    expect(strict.requirements.some((r) => /512 octets/u.test(r.exact_text))).toBe(false);
    expect(candidates.declarative_specifications.some((r) => /512 octets/u.test(r.exact_text))).toBe(true);
    // The provisional surface is the candidate list, and the row is not in it.
    expect(candidates.candidates.some((c) => /512 octets/u.test(c.exact_text))).toBe(false);
  });

  it("caps the list and says which cap stopped it", () => {
    const { candidates } = both(KEYWORD_FREE, 2);
    expect(candidates.declarative_specifications).toHaveLength(2);
    expect(candidates.declarative_specifications_truncated).toBe(true);
    expect(candidates.warnings).toContain("declarative_specifications_truncated_at_2");
  });

  it("excludes the publication artefacts the rule names, and counts them", () => {
    const raw = [
      "2.  Limits",
      "",
      "   Figure 1: a message that is 512 octets long.",
      "",
      "   See Section 3.1 for the 512 octet limit on a command line.",
      "",
      '   [RFC5321] J. Reynolds, and J. Postel, "Simple Mail Transfer Protocol", which',
      "   limits a command line to 512 octets.",
      "",
      "   o  The limit is 512 octets for every command.",
      "",
      "   The limit is 512 octets for every command.",
      "",
    ].join("\n");
    const { candidates } = both(raw);
    expect(candidates.declarative_specifications.map((r) => r.exact_text)).toEqual([
      "The limit is 512 octets for every command.",
    ]);
    // A filter nobody can see is indistinguishable from a filter that hides a miss, so
    // every exclusion is counted and named.
    const warnings = candidates.warnings.join(" ");
    expect(warnings).toContain("declarative_caption_or_figure_label_excluded:1");
    expect(warnings).toContain("declarative_cross_reference_excluded:1");
    expect(warnings).toContain("declarative_list_item_excluded:1");
  });

  it("tells a document's own statement of its requirements from a keyword-free one", () => {
    // A sentence that carries a keyword belongs to the strict and candidate channels
    // and to neither of these, so the two lists can never both own it.
    const raw = [
      "2.  Limits",
      "",
      "   The maximum total length of a command line is 512 octets.",
      "",
      "   A server must reject any longer line.",
      "",
    ].join("\n");
    const { candidates } = both(raw);
    expect(candidates.candidates.map((c) => c.exact_text)).toEqual(["A server must reject any longer line."]);
    expect(candidates.declarative_specifications.map((r) => r.exact_text)).toEqual([
      "The maximum total length of a command line is 512 octets.",
    ]);
  });

  it("answers the same question from the entry point the service has to call", () => {
    // The service cannot use the key above: it hands `analyzeNormativeCandidates` the
    // blocks `store.listBlocksWithKeywords` returned, and that query filters on
    // `lower(text) LIKE '%must%'` and six more stems, so a paragraph whose only
    // specification is "the maximum is 512 octets" never reaches the analysis at all.
    // This is the function the service has to call with the snapshot's whole block set,
    // and it is a second, independent reason the 13 statements were unreachable.
    const standalone = analyzeDeclarativeSpecifications(parse(KEYWORD_FREE));
    const { candidates } = both(KEYWORD_FREE);
    expect(standalone.declarative_specifications.map((r) => r.exact_text)).toEqual(
      candidates.declarative_specifications.map((r) => r.exact_text),
    );
    expect(standalone.declarative_by_basis).toEqual(candidates.declarative_by_basis);
  });
});

/**
 * A row that states the opposite of its own sentence is the worst output this extractor
 * can produce: a contract built from it requires the behaviour the RFC forbids.
 *
 * Measured before the fix, at index_generation 1981: 16 requirement rows reported with
 * `polarity: "positive"` and no flag. `req_76dcffb7c47de7e6` is "A registrar MUST not
 * generate 6xx responses." - MUST, positive, confidence 0.9. RFC 1812 §3.3.2 has the same
 * shape: "A router MUST not believe any ARP reply..."
 *
 * The input goes through `parseRfcText` rather than a hand-built block, so the sentence
 * these assertions are about is the sentence the parser actually produced, wrapped and
 * classified, instead of a fixture shaped to suit the assertion.
 */
describe("a keyword negated by a separately printed not", () => {
  const row = (sentence: string) => {
    const raw = [
      "                                                  Router Requirements",
      "                                                                     RFC 1812",
      "",
      "3.3.2.  Router Requirements",
      "",
      sentence,
      "",
    ].join("\n");
    return analyze(raw).analysis.requirements[0];
  };

  it("reports the row as a prohibition, not as an obligation", () => {
    const found = row(
      "A router MUST not believe any ARP reply received on an interface\n   that is not configured for ARP.",
    );
    expect(found?.polarity).toBe("negative");
    expect(found?.term).toBe("MUST NOT");
  });

  it("records that the RFC wrote the negation in the wrong case, so a strict caller can see the deviation", () => {
    expect(row("A registrar MUST not generate 6xx responses.")?.flags).toContain("negation_case_not_upper");
  });

  it("still quotes the whole sentence, so the citation is of the author's own words", () => {
    expect(row("A router MUST not believe any ARP reply.")?.exact_text).toContain(
      "A router MUST not believe any ARP reply",
    );
  });

  it("emits one row, not a positive row and a negative row", () => {
    const raw = "3.3.2.  Router Requirements\n\nA registrar MUST not generate 6xx responses.\n";
    expect(analyze(raw).analysis.requirements).toHaveLength(1);
  });

  it.each([
    ["MUST not send a reply", "MUST NOT", "negative"],
    ["SHOULD not be set to zero", "SHOULD NOT", "negative"],
    ["MUST  not  send a reply", "MUST NOT", "negative"],
  ])("folds the negation for %j", (sentence, term, polarity) => {
    const found = row(sentence);
    expect([found?.term, found?.polarity]).toEqual([term, polarity]);
  });

  it("folds the negation across the line break a hard-wrapped RFC puts in it", () => {
    const found = row("A host MUST\n   not send a FIN in that state.");
    expect([found?.term, found?.polarity]).toEqual(["MUST NOT", "negative"]);
  });

  it.each([
    // The `not` opens the next clause, so it negates nothing about the keyword.
    "The server MUST, not because it is optional, ignore the field.",
    // No `not` near the keyword at all.
    "A host MUST be able to accept a connection.",
    // A `not` later in the sentence, well past the clause the keyword governs.
    "A host MUST be able to accept a connection, and not every host will.",
    // `note` is not `not`: a prefix match here would invert an obligation.
    "An implementation MUST note that the value is advisory.",
  ])("leaves the positive reading alone for %j", (sentence) => {
    const found = row(sentence);
    expect(found?.polarity).toBe("positive");
    expect(found?.flags).not.toContain("negation_case_not_upper");
  });

  it("leaves an upper-case MUST NOT untouched, because the phrase already carries the polarity", () => {
    const found = row("A host MUST NOT send a FIN in that state.");
    expect([found?.term, found?.polarity]).toEqual(["MUST NOT", "negative"]);
    expect(found?.flags).not.toContain("negation_case_not_upper");
  });
  it("leaves an upper-case MUST NOT untouched, because the phrase already carries the polarity", () => {
    const found = row("A host MUST NOT send a FIN in that state.");
    expect([found?.term, found?.polarity]).toEqual(["MUST NOT", "negative"]);
    expect(found?.flags).not.toContain("negation_case_not_upper");
  });

  /**
   * A keyword is quoted when the quotes enclose IT. It was a two-character window in each
   * direction, so any quote mark near the keyword made the sentence a *definition* - and the
   * candidate pass then deletes a definition because the strict pass already owns the
   * keyword.
   *
   * Measured: RFC 1123 §5.2.16, `"domain" MUST NOT interpret…`, puts a `"` two characters
   * before the keyword, so the sentence became a definition mention and appeared in NEITHER
   * channel. RFC 3261 §19.1.1, `"phone" SHOULD be present`, is the same window compounded by
   * the 500-row mention cap, so it is invisible and no counter moves.
   */
  describe("a quoted field name near a keyword does not make the keyword quoted", () => {
    const body = (sentence: string) => analyze(["3.3.2.  Router Requirements", "", sentence, ""].join("\n")).analysis;

    it.each([
      'The "domain" MUST NOT interpret a name with a trailing dot.',
      'The "phone" SHOULD be present in every request.',
      'A "port" MUST be within the range the header declares.',
      'The "type" MAY be omitted when the default applies.',
    ])("keeps %j a requirement", (sentence) => {
      const requirements = body(sentence).requirements;
      expect(requirements).toHaveLength(1);
      expect(requirements[0]!.flags).not.toContain("term_quoted");
    });

    it.each([
      'The "MUST" keyword is defined in RFC 2119.',
      "The 'MUST NOT' construct negates the requirement.",
      'Section 3.1 uses "SHOULD" to mean a recommendation.',
    ])("still treats %j as a mention about the language, not a requirement", (sentence) => {
      const result = body(sentence);
      expect(result.requirements).toHaveLength(0);
      expect(result.mentions.some((mention) => mention.disposition === "definition")).toBe(true);
    });

    it("reports the quoted field name case through the strict channel, which is where it belongs", () => {
      const requirements = body('The "domain" MUST NOT interpret a name with a trailing dot.').requirements;
      expect(requirements[0]!.polarity).toBe("negative");
      expect(requirements[0]!.exact_text).toContain('The "domain" MUST NOT interpret');
    });
  });

  it("does not flag the upper-case phrase, which is a deviation by nothing", () => {
    // Regression: the flag was pushed whenever a `not` followed the keyword, which marked
    // 112 rows, and the great majority of them were the correctly matched upper-case
    // `MUST NOT` - written correctly by the RFC, and not a deviation at all. A flag that
    // fires on correct input is a flag nobody reads.
    const found = row("It MUST NOT be used as a source address.");
    expect([found?.term, found?.polarity]).toEqual(["MUST NOT", "negative"]);
    expect(found?.flags ?? []).not.toContain("negation_case_not_upper");
  });

  it("does not flag a sentence whose `not` follows some other word", () => {
    const found = row(
      "A host that is forwarding the message but is not the destination\n   host may drop the message.",
    );
    expect(found?.flags ?? []).not.toContain("negation_case_not_upper");
  });
});

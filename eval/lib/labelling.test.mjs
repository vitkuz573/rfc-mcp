// Tests for the label-free invariant in labelling.mjs.
//
//   node --test eval/lib/labelling.test.mjs
//
// `danglingHeadings` is the one rule in the bench that needs no golden label: it compares
// what a document's text shows against what its outline lists, and it is what caught the
// indented-heading defect - 63 subsection numbers across RFC 959, 1122, 1123 and 2300
// that no query could reach. It is also the rule most able to cry wolf, because it reads
// heading shape out of raw lines and every document contains a line that begins with a
// number. A guard that reports a sentence as a title gets ignored, and once it is ignored
// it catches nothing, so both directions are pinned here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { danglingHeadings } from "./labelling.mjs";

/** The outline after the defect: top-level numbers only, the subsections dropped. */
const TOP_LEVEL_ONLY = ["", "1", "2", "3", "4"];

/** The same document once the parser reaches its own subsection titles. */
const WITH_SUBSECTIONS = ["", "1", "2", "3", "3.3", "3.3.1", "3.3.2", "4"];

describe("danglingHeadings", () => {
  it("reports an indented subsection title the outline omits", () => {
    // The defect in its own shape: RFC 1122 sets these three columns in, and an outline
    // that stopped at section 4 left everything under 3.3.1 unreachable.
    const text = [
      "   3.3.1  Routing Outbound Datagrams",
      "",
      "            The route cache MUST be flushed on a metric change, and",
      "            the host SHOULD log the change for later diagnosis.",
      "",
    ].join("\n");
    assert.deepEqual(danglingHeadings(text, TOP_LEVEL_ONLY), [
      { number: "3.3.1", title: "3.3.1  Routing Outbound Datagrams" },
    ]);
  });

  it("does not report a sentence that merely begins with a number", () => {
    // A bare integer in lower case: no title on the page says this, and a reader sent
    // to section 1983 finds nothing.
    const text = [
      "            1983 must not be read as a section number here.",
      "            A host MUST reject a datagram with a bad checksum.",
    ].join("\n");
    assert.deepEqual(danglingHeadings(text, TOP_LEVEL_ONLY), []);
  });

  it("does not report a numbered sentence that opens with an RFC 2119 keyword", () => {
    // The same trap with a dotted number and an upper-case word, which is the only shape
    // a paragraph can reach, and it needs no paragraph-like indent to get there: RFC 1123
    // sets its body text three columns in, so this line is where such a sentence would
    // sit. The parser refuses to promote it for exactly this reason, so an invariant that
    // reported it would point at something the parser deliberately never called a
    // section.
    const text = [
      "   3.3.1  The sender",
      "",
      "            The route cache MUST be flushed on a metric change, and",
      "   3.3.2 MUST be set on every interface that transmits datagrams",
    ].join("\n");
    assert.deepEqual(danglingHeadings(text, TOP_LEVEL_ONLY), [{ number: "3.3.1", title: "3.3.1  The sender" }]);
  });

  it("does not report the first line of a wrapped sentence", () => {
    // Body text that opens a line with a number is the most ordinary thing in a typeset
    // document, and only the line that follows gives it away: it carries on at the same
    // indent, where a title is followed by a blank line or by body that steps in.
    const text = ["      4.2.1  This section describes the interface to the", "      transport layer in detail."].join(
      "\n",
    );
    assert.deepEqual(danglingHeadings(text, TOP_LEVEL_ONLY), []);
  });

  it("does not report a heading the outline already lists", () => {
    // The other half of the comparison: a number the outline carries is reachable,
    // whatever the text does with it, and the invariant is about the difference.
    const text = ["   3.3  SPECIFIC ISSUES", "", "      3.3.1  Routing Outbound Datagrams"].join("\n");
    assert.deepEqual(danglingHeadings(text, WITH_SUBSECTIONS), []);
  });

  it("reports a title the sampled section ends on", () => {
    // A section sampled from the outline can end on the title of the next one, and there
    // is no line under it to judge by.
    assert.deepEqual(danglingHeadings("   3.3.1  Routing Outbound Datagrams", TOP_LEVEL_ONLY), [
      { number: "3.3.1", title: "3.3.1  Routing Outbound Datagrams" },
    ]);
  });

  it("reports each number once and keeps the first title it saw", () => {
    // A document that repeats a title - a contents block, a running head - has one
    // missing section, not two, and the count is what the bench prints.
    const text = [
      "   4.1  USER DATAGRAM PROTOCOL -- UDP",
      "",
      "            A host MUST handle datagrams addressed to a UDP port.",
      "",
      "   4.1  USER DATAGRAM PROTOCOL -- UDP",
      "",
      "            A host SHOULD ignore a datagram sent to a closed port.",
    ].join("\n");
    assert.deepEqual(danglingHeadings(text, TOP_LEVEL_ONLY), [
      { number: "4.1", title: "4.1  USER DATAGRAM PROTOCOL -- UDP" },
    ]);
  });

  it("survives an empty document, an empty outline and missing input", () => {
    assert.deepEqual(danglingHeadings("", []), []);
    assert.deepEqual(danglingHeadings(undefined, undefined), []);
    assert.deepEqual(danglingHeadings("   4.1  USER DATAGRAM PROTOCOL -- UDP", []), [
      { number: "4.1", title: "4.1  USER DATAGRAM PROTOCOL -- UDP" },
    ]);
  });
});

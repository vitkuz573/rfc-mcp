import { describe, expect, it } from "vitest";

import { parseXml, textContent, findChild, findChildren, findRoot } from "../src/parse/xml.js";
import { parseRfcXmlOutline } from "../src/parse/rfcXml.js";

const RFCXML = `<?xml version='1.0' encoding='utf-8'?>
<rfc xmlns:xi="http://www.w3.org/2001/XInclude" version="3" number="9110" docName="draft-x-y" obsoletes="2616,7230" updates="3864" ipr="trust200902">
  <front>
    <title>HTTP Semantics</title>
    <seriesInfo name="RFC" value="9110" stream="IETF"/>
    <author fullname="R. Fielding"/>
  </front>
  <section anchor="introduction"><name>1</name><title>Introduction</title>
    <t>The client MUST send a request.  See <xref target="methods"/>.</t>
    <section anchor="purpose"><name>1.1</name><title>Purpose</title>
      <t>An implementation SHOULD log errors.</t>
    </section>
  </section>
  <back>
    <references anchor="normative-references">
      <name>Normative References</name>
      <reference anchor="RFC2119">
        <front><refcontent>Bradner, S., "Key words", BCP 14, RFC 2119.</refcontent></front>
      </reference>
    </references>
    <section anchor="collected-abnf"><name>Appendix A</name><title>Collected ABNF</title>
      <sourcecode><![CDATA[  method = token]]></sourcecode>
    </section>
  </back>
</rfc>
`;

describe("hardened XML reader", () => {
  it("parses elements, attributes, CDATA and entities", () => {
    const roots = parseXml(RFCXML);
    const rfc = findRoot(roots, "rfc");
    expect(rfc?.attrs.number).toBe("9110");
    expect(rfc?.attrs.obsoletes).toBe("2616,7230");
    const front = findChild(rfc!, "front")!;
    expect(textContent(findChild(front, "title")!)).toBe("HTTP Semantics");
    expect(findChildren(front, "seriesInfo")[0]?.attrs.stream).toBe("IETF");
  });

  it("rejects DTD and entity declarations", () => {
    expect(() => parseXml('<!DOCTYPE rfc [<!ENTITY x "y">]><rfc/>')).toThrowError(/DTD|entity/u);
    expect(() => parseXml('<!ENTITY x "y">')).toThrowError(/DTD|entity/u);
  });

  it("does not expand external entities", () => {
    const xml = "<rfc><t>&xxe;</t></rfc>";
    const roots = parseXml(xml);
    expect(textContent(roots[0]!)).toBe("&xxe;");
  });

  it("rejects mismatched and unclosed tags", () => {
    expect(() => parseXml("<a><b></a></b>")).toThrowError(/Mismatched/u);
    expect(() => parseXml("<a><b>")).toThrowError(/Unclosed/u);
  });

  it("enforces the nesting limit", () => {
    const deep = `${"<a>".repeat(200)}x${"</a>".repeat(200)}`;
    expect(() => parseXml(deep, { maxDepth: 32, maxNodes: 1000, maxTextChars: 1000 })).toThrowError(/depth/u);
  });

  it("keeps character offsets into the source", () => {
    const source = "<rfc><t>alpha</t><t>beta</t></rfc>";
    const roots = parseXml(source);
    const rfc = roots[0]!;
    const [first, second] = findChildren(rfc, "t");
    expect(source.slice(first!.startChar, first!.endChar)).toBe("<t>alpha</t>");
    expect(source.slice(second!.startChar, second!.endChar)).toBe("<t>beta</t>");
  });

  it("builds an RFCXML outline with anchors and nested sections", () => {
    const outline = parseRfcXmlOutline(Buffer.from(RFCXML, "utf8"));
    expect(outline.number).toBe(9110);
    expect(outline.obsoletes).toEqual([2616, 7230]);
    expect(outline.updates).toEqual([3864]);
    expect(outline.series[0]?.value).toBe("9110");
    expect(outline.sections).toHaveLength(2);
    const introduction = outline.sections[0]!;
    expect(introduction.anchor).toBe("introduction");
    expect(introduction.title).toBe("Introduction");
    expect(introduction.children[0]?.anchor).toBe("purpose");
    expect(introduction.normative_terms).toContain("MUST");
    expect(outline.sections[1]?.kind).toBe("appendix");
  });
});

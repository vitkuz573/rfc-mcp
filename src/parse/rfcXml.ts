/**
 * RFCXML (RFC 7749 v2 / RFC 7991 v3) outline extraction.
 *
 * The RFCXML view complements the plain-text parse: it exposes the authoritative
 * section tree, anchors, `relRefs` and `seriesInfo` metadata, and per-section
 * structure without any heuristic heading detection. It is exposed through
 * `rfc_read(format: "xml_outline")` and `rfc_source`; normative extraction and
 * byte-exact citations always run on the plain-text publication version, which
 * exists for every RFC.
 */

import { RfcMcpError } from "../core/errors.js";
import type { BlockKind, SectionKind } from "../core/types.js";
import { findChild, findChildren, findRoot, parseXml, textContent, type XmlNode } from "./xml.js";

export interface XmlOutlineSection {
  readonly anchor: string;
  readonly number: string | null;
  readonly title: string;
  readonly kind: SectionKind;
  readonly path: readonly string[];
  readonly parent_anchor: string | null;
  readonly children: readonly XmlOutlineSection[];
  readonly block_count: number;
  readonly normative_terms: readonly string[];
  readonly references: readonly string[];
  readonly char_span: { readonly start: number; readonly end: number };
}

export interface XmlDocumentOutline {
  readonly doc_name: string | null;
  readonly number: number | null;
  readonly version: string | null;
  readonly ipr: string | null;
  readonly category: string | null;
  readonly obsoletes: readonly number[];
  readonly updates: readonly number[];
  readonly series: readonly { readonly name: string; readonly value: string; readonly stream: string | null }[];
  readonly sections: readonly XmlOutlineSection[];
  readonly warnings: readonly string[];
}

const NORMATIVE_TERM =
  /\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|SHALL|REQUIRED|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b/gu;
const CITATION = /\[\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:,\s*[^\]]*)?\]/gu;

export function parseRfcXmlOutline(raw: Buffer): XmlDocumentOutline {
  const source = new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);
  const roots = parseXml(source);
  const rfc = findRoot(roots, "rfc");
  if (!rfc) {
    throw new RfcMcpError("PARSE_FAILED", "RFCXML root element <rfc> not found");
  }
  const warnings: string[] = [];
  const front = findChild(rfc, "front");
  const middle = findChild(rfc, "middle");
  const back = findChild(rfc, "back");

  // RFCXML v3 wraps the body in <middle>; a few older documents place <section>
  // directly under <rfc>. Reading only the direct children would silently return
  // back matter for every modern document, so <middle> is the primary source and
  // the direct children are only a fallback.
  const directSections = rfc.children.filter((child) => child.local === "section");
  const middleSections = middle ? findChildren(middle, "section") : [];
  const bodySections = middleSections.length > 0 ? middleSections : directSections;
  if (middleSections.length > 0 && directSections.length > 0) {
    warnings.push("section_outside_middle_ignored");
  }

  // <references> lives in front for v2 documents. It belongs after the body, and is
  // used only when the document has no back matter of its own. In v3 the references
  // section is a <references> element rather than a <section>, and it is part of the
  // outline: the plain-text parse exposes it too, and dropping it here would make the
  // two representations disagree about the document's structure.
  const isSectionNode = (node: XmlNode): boolean => node.local === "section" || node.local === "references";
  const frontReferences = front ? findChildren(front, "references") : [];
  const backSections = back?.children.filter(isSectionNode) ?? [];
  const trailingReferences = backSections.length === 0 ? frontReferences : [];
  if (backSections.length === 0 && frontReferences.length > 0) {
    warnings.push("references_taken_from_front_matter");
  }

  const sectionRoots: XmlNode[] = [...bodySections, ...backSections, ...trailingReferences];

  const sections = sectionRoots.map((node) => buildSection(node, warnings, null));
  const series = (front ? findChildren(front, "seriesInfo") : []).map((node) => ({
    name: node.attrs.name ?? "",
    value: node.attrs.value ?? "",
    stream: node.attrs.stream ?? null,
  }));

  return {
    doc_name: rfc.attrs.docName ?? null,
    number: rfc.attrs.number ? Number.parseInt(rfc.attrs.number, 10) : null,
    version: rfc.attrs.version ?? null,
    ipr: rfc.attrs.ipr ?? null,
    category: rfc.attrs.category ?? null,
    obsoletes: parseNumberList(rfc.attrs.obsoletes),
    updates: parseNumberList(rfc.attrs.updates),
    series,
    sections,
    warnings,
  };
}

function buildSection(node: XmlNode, warnings: string[], parentAnchor: string | null): XmlOutlineSection {
  // RFCXML v3 dropped the `number` attribute: the numbering lives in the page name
  // ("section-1.1", "section-appendix.a"). Reading it there is what makes the XML
  // outline authoritative instead of a second, weaker guess.
  const derivedAnchor = node.attrs.pn ? `pn-${node.attrs.pn}` : "";
  const anchor = node.attrs.anchor ?? node.attrs.slug ?? derivedAnchor;
  if (anchor === "") warnings.push("section_without_anchor");
  const titleNode = findChild(node, "title");
  const sectionName = findChild(node, "name");
  const name = sectionName ? textContent(sectionName).replace(/\s+/gu, " ").trim() : "";
  // A v3 <section> carries its visible heading in <name>; <title> is the front-matter
  // document title. Prefer <title> when present, fall back to <name>.
  const title = titleNode ? textContent(titleNode).replace(/\s+/gu, " ").trim() : name;
  const number = node.attrs.number ?? numberFromPageName(node.attrs.pn) ?? (name ? name : null);

  const text = textContent(node);
  const terms = new Set<string>();
  for (const match of text.matchAll(NORMATIVE_TERM)) terms.add(match[1]!);
  const references = new Set<string>();
  for (const match of text.matchAll(CITATION)) references.add(match[1]!);
  // RFCXML carries citations as <xref target="...">, which is the whole reason to
  // read the XML: the target is exact, whereas the rendered label is presentation.
  for (const xref of collectXrefTargets(node)) references.add(xref);

  const ownBlocks = node.children.filter((child) => !["section", "references", "title", "name"].includes(child.local));
  const children = node.children
    .filter((child) => child.local === "section" || child.local === "references")
    .map((child) => buildSection(child, warnings, anchor));

  return {
    anchor,
    number,
    title,
    kind: classifyXmlSection(node.local, title, number, parentAnchor),
    path: parentAnchor ? [parentAnchor, number ?? title, title] : [number ?? title, title],
    parent_anchor: parentAnchor,
    children,
    block_count: countBlocks(ownBlocks),
    normative_terms: [...terms].sort(),
    references: [...references].sort(),
    char_span: { start: node.startChar, end: node.endChar },
  };
}

/**
 * Recovers the rendered section number from an RFCXML v3 page name.
 * `section-1.1` → `1.1`, `section-appendix.a` → `Appendix A`. Returns null when the
 * page name carries no section numbering, so a guess is never invented.
 */
function numberFromPageName(pn: string | undefined): string | null {
  if (!pn) return null;
  const appendix = /^section-appendix\.([a-z])(\.[0-9]+)*$/iu.exec(pn);
  if (appendix) {
    const letter = appendix[1]!.toUpperCase();
    const sub = appendix[0]!.slice(`section-appendix.${appendix[1]!}`.length);
    return `Appendix ${letter}${sub.replace(/\./gu, ".")}`;
  }
  const numbered = /^section-([0-9]+(?:\.[0-9]+)*)$/u.exec(pn);
  return numbered ? numbered[1]! : null;
}

/** Every `xref` target below `node`, in document order, de-duplicated later by the caller. */
function collectXrefTargets(node: XmlNode): string[] {
  const targets: string[] = [];
  const stack: XmlNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.local === "xref") {
      const target = current.attrs.target;
      if (target) targets.push(target);
    }
    for (const child of current.children) stack.push(child);
  }
  return targets;
}

function countBlocks(nodes: readonly XmlNode[]): number {
  let count = 0;
  for (const node of nodes) {
    switch (node.local) {
      case "t":
      case "li":
      case "dt":
      case "dd":
      case "figure":
      case "artwork":
      case "table":
      case "sourcecode":
        count += 1;
        break;
      default:
        count += countBlocks(node.children);
    }
  }
  return count;
}

function classifyXmlSection(
  element: string,
  title: string,
  number: string | null,
  parentAnchor: string | null,
): SectionKind {
  // The element name is authoritative: a <references> element is the references
  // section even when its rendered title is empty. The remaining rules mirror
  // classifyKind in the plain-text parser exactly, so the two representations of a
  // document never disagree about what kind of section they are looking at.
  if (element === "references") return "references";
  const lower = title.toLowerCase();
  if (number?.startsWith("Appendix")) return "appendix";
  if (lower === "references" || lower === "normative references" || lower === "informative references") {
    return "references";
  }
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
  void parentAnchor;
  return "body";
}

function parseNumberList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
}

export function xmlBlockKind(node: XmlNode): BlockKind {
  switch (node.local) {
    case "t":
      return "paragraph";
    case "li":
      return "list_item";
    case "sourcecode":
    case "artwork":
      return "preformatted";
    case "table":
      return "table";
    case "figure":
      return "figure";
    case "reference":
      return "reference_entry";
    default:
      return "unknown";
  }
}

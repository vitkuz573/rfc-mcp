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
  const back = findChild(rfc, "back");
  if (front) {
    // <references> may live in front for v2 documents.
    for (const references of findChildren(front, "references")) {
      back?.children.push(references);
    }
  }

  const sectionRoots: XmlNode[] = [
    ...rfc.children.filter((child) => child.local === "section"),
    ...(back?.children.filter((child) => child.local === "section") ?? []),
  ];

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
  const anchor = node.attrs.anchor ?? node.attrs.slug ?? "";
  if (anchor === "") warnings.push("section_without_anchor");
  const titleNode = findChild(node, "title");
  const title = titleNode ? textContent(titleNode).replace(/\s+/gu, " ").trim() : "";
  const sectionName = findChild(node, "name");
  const name = sectionName ? textContent(sectionName).replace(/\s+/gu, " ").trim() : "";
  const number = node.attrs.number ?? (name ? name : null);

  const text = textContent(node);
  const terms = new Set<string>();
  for (const match of text.matchAll(NORMATIVE_TERM)) terms.add(match[1]!);
  const references = new Set<string>();
  for (const match of text.matchAll(CITATION)) references.add(match[1]!);

  const ownBlocks = node.children.filter((child) => !["section", "title", "name"].includes(child.local));
  const children = node.children
    .filter((child) => child.local === "section")
    .map((child) => buildSection(child, warnings, anchor));

  return {
    anchor,
    number,
    title,
    kind: classifyXmlSection(title, number, parentAnchor),
    path: parentAnchor ? [parentAnchor, number ?? title, title] : [number ?? title, title],
    parent_anchor: parentAnchor,
    children,
    block_count: countBlocks(ownBlocks),
    normative_terms: [...terms].sort(),
    references: [...references].sort(),
    char_span: { start: node.startChar, end: node.endChar },
  };
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

function classifyXmlSection(title: string, number: string | null, parentAnchor: string | null): SectionKind {
  const lower = title.toLowerCase();
  if (number && /^appendix\s+/iu.test(number)) return "appendix";
  if (lower.includes("reference")) return "references";
  if (lower === "index") return "index";
  if (lower.includes("author") || lower.includes("contributor")) return "authors";
  if (
    lower === "abstract" ||
    lower.includes("status") ||
    lower.includes("copyright") ||
    lower.includes("intellectual property") ||
    lower.includes("notice")
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

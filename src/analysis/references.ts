/**
 * Reference extraction and dependency edges.
 *
 * Two passes over the parsed document:
 *  1. the reference sections become `reference_entry` blocks, each with a
 *     label, a resolved target (RFC/BCP/STD/FYI) and a relation
 *     (normative / informative);
 *  2. every other prose block is scanned for `[Label]` citations, which are
 *     attached to the matching reference record with an exact offset.
 *
 * A citation is never turned into a "dependency" by inference: the only
 * non-evidence edge this module produces is `uses_bcp14`, which is a fact about
 * RFC 2119/8174 adoption rather than a protocol dependency, and it is labelled
 * as such.
 */

import type { Block, EdgeType, GraphEdge, GraphNode, ReferenceRecord, Section } from "../core/types.js";
import { citationId } from "./citation.js";
import { shortHash } from "../core/util.js";

const ENTRY_PATTERN = /^\s*\[([^\]]{1,80})\]\s*/u;
const RFC_IN_TEXT = /\bRFC\s*(\d{1,5})\b/iu;
const BCP_IN_TEXT = /\bBCP\s*(\d{1,5})\b/iu;
const STD_IN_TEXT = /\bSTD\s*(\d{1,5})\b/iu;
const FYI_IN_TEXT = /\bFYI\s*(\d{1,5})\b/iu;
const LABEL_NUMBER = /^([A-Z]+)[\s-]?(\d{1,5})$/u;
const CITATION_SCAN = /\[\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:,\s*[^\]]*)?\]/gu;

export interface ReferenceAnalysis {
  readonly references: readonly ReferenceRecord[];
  readonly warnings: readonly string[];
}

export function analyzeReferences(input: {
  readonly snapshotId: string;
  readonly rfc: number;
  readonly sections: readonly Section[];
  readonly blocks: readonly Block[];
}): ReferenceAnalysis {
  const warnings: string[] = [];
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const references: ReferenceRecord[] = [];
  const byLabel = new Map<string, ReferenceRecord>();
  let ordinal = 0;

  for (const block of input.blocks) {
    if (block.kind !== "reference_entry") continue;
    const section = sectionsById.get(block.section_id);
    const relation = relationForSection(section, input.sections);
    if (relation === null) continue;
    const entry = ENTRY_PATTERN.exec(block.text);
    if (!entry) {
      warnings.push(`reference_entry_without_label:${block.id}`);
      continue;
    }
    const label = entry[1]!.trim();
    const resolved = resolveTarget(label, block.text);
    const record: ReferenceRecord = {
      id: `ref_${shortHash(`${input.snapshotId}|${label}|${ordinal}`)}`,
      snapshot_id: input.snapshotId,
      rfc: input.rfc,
      section_id: block.section_id,
      ordinal,
      label,
      raw_text: block.text,
      relation,
      target_kind: resolved.kind,
      target: resolved.target,
      target_rfc: resolved.rfc,
      resolution: resolved.resolution,
      cited_by: [],
    };
    ordinal += 1;
    references.push(record);
    byLabel.set(label.toLowerCase(), record);
  }

  // In-body citations, including label-style citations such as [HTTP].
  for (const block of input.blocks) {
    if (block.kind === "reference_entry") continue;
    const section = sectionsById.get(block.section_id);
    if (section && (section.kind === "references" || section.kind === "authors" || section.kind === "index")) continue;
    CITATION_SCAN.lastIndex = 0;
    for (const match of block.text.matchAll(CITATION_SCAN)) {
      const label = match[1]!;
      const lower = label.toLowerCase();
      const existing = byLabel.get(lower);
      const offset = block.char_start + (match.index ?? 0);
      if (existing) {
        (existing.cited_by as { block_id: string; section_id: string; offset: number }[]).push({
          block_id: block.id,
          section_id: block.section_id,
          offset,
        });
        continue;
      }
      const resolved = resolveTarget(label, block.text.slice(match.index ?? 0, (match.index ?? 0) + label.length + 4));
      if (resolved.rfc === null && resolved.target === null) continue;
      const record: ReferenceRecord = {
        id: `ref_${shortHash(`${input.snapshotId}|inbody|${label}|${ordinal}`)}`,
        snapshot_id: input.snapshotId,
        rfc: input.rfc,
        section_id: block.section_id,
        ordinal,
        label,
        raw_text: block.text.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 80).trim(),
        relation: "in_body",
        target_kind: resolved.kind,
        target: resolved.target,
        target_rfc: resolved.rfc,
        resolution: resolved.resolution,
        cited_by: [{ block_id: block.id, section_id: block.section_id, offset }],
      };
      ordinal += 1;
      references.push(record);
      if (resolved.rfc !== null) byLabel.set(lower, record);
    }
  }

  if (references.some((reference) => reference.resolution === "unresolved")) {
    warnings.push("some_references_unresolved");
  }
  return { references, warnings };
}

function relationForSection(section: Section | undefined, all: readonly Section[]): ReferenceRecord["relation"] | null {
  if (!section) return null;
  const titles = new Set<string>();
  let current: Section | undefined = section;
  while (current) {
    titles.add(current.title.toLowerCase());
    current = current.parent_id ? all.find((candidate) => candidate.id === current!.parent_id) : undefined;
  }
  for (const title of titles) {
    if (title === "normative references") return "normative";
    if (title === "informative references") return "informative";
  }
  if (section.kind === "references") return "informative";
  return null;
}

interface ResolvedTarget {
  readonly kind: ReferenceRecord["target_kind"];
  readonly target: string | null;
  readonly rfc: number | null;
  readonly resolution: ReferenceRecord["resolution"];
}

function resolveTarget(label: string, text: string): ResolvedTarget {
  const labelMatch = LABEL_NUMBER.exec(label.replace(/\s+/gu, " ").trim());
  if (labelMatch) {
    const prefix = labelMatch[1]!.toUpperCase();
    const number = Number.parseInt(labelMatch[2]!, 10);
    if (prefix === "RFC") return { kind: "rfc", target: `rfc-${number}`, rfc: number, resolution: "exact" };
    if (prefix === "BCP" || prefix === "STD" || prefix === "FYI") {
      const referenced = RFC_IN_TEXT.exec(text)?.[1];
      return {
        kind: "subseries",
        target: `${prefix.toLowerCase()}-${number}`,
        rfc: referenced ? Number.parseInt(referenced, 10) : null,
        resolution: referenced ? "exact" : "ambiguous",
      };
    }
  }
  const rfcMatch = RFC_IN_TEXT.exec(text);
  if (rfcMatch?.[1])
    return {
      kind: "rfc",
      target: `rfc-${Number.parseInt(rfcMatch[1], 10)}`,
      rfc: Number.parseInt(rfcMatch[1], 10),
      resolution: "exact",
    };
  const bcp = BCP_IN_TEXT.exec(text)?.[1];
  if (bcp) return { kind: "subseries", target: `bcp-${Number.parseInt(bcp, 10)}`, rfc: null, resolution: "exact" };
  const std = STD_IN_TEXT.exec(text)?.[1];
  if (std) return { kind: "subseries", target: `std-${Number.parseInt(std, 10)}`, rfc: null, resolution: "exact" };
  const fyi = FYI_IN_TEXT.exec(text)?.[1];
  if (fyi) return { kind: "subseries", target: `fyi-${Number.parseInt(fyi, 10)}`, rfc: null, resolution: "exact" };
  return { kind: "other", target: null, rfc: null, resolution: "unresolved" };
}

/* -------------------------------------------------------------------------- */
/* Dependency graph                                                            */
/* -------------------------------------------------------------------------- */

export interface GraphInput {
  readonly rootRfc: number;
  readonly rootSnapshotId: string;
  readonly references: readonly ReferenceRecord[];
  readonly metadata: {
    readonly obsoletes: readonly number[];
    readonly obsoleted_by: readonly number[];
    readonly updates: readonly number[];
    readonly updated_by: readonly number[];
  };
  readonly inbound: readonly {
    readonly rfc: number;
    readonly relation: string;
    readonly evidence: GraphEdge["evidence"];
  }[];
  readonly titles: ReadonlyMap<number, string>;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly depth: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly observedAt: string;
}

export function buildGraph(input: GraphInput): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  unresolved: string[];
} {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const unresolved: string[] = [];
  let truncated = false;

  const rootId = `doc:rfc-${input.rootRfc}`;
  addNode(nodes, input.rootRfc, input.titles.get(input.rootRfc), "resolved");

  const pushEdge = (
    to: number | null,
    type: EdgeType,
    relation: string,
    evidence: GraphEdge["evidence"],
    targetLabel?: string,
  ): void => {
    const from = rootId;
    const toId = to === null ? `label:${targetLabel ?? "unknown"}` : `doc:rfc-${to}`;
    if (to !== null) addNode(nodes, to, input.titles.get(to), "resolved");
    else unresolved.push(targetLabel ?? "unknown");
    if (edges.length >= input.maxEdges) {
      truncated = true;
      return;
    }
    const id = `edge_${shortHash(`${from}|${toId}|${type}|${relation}`)}`;
    if (edges.some((edge) => edge.id === id)) return;
    edges.push({ id, from, to: toId, type, relation, evidence });
  };

  for (const reference of input.references) {
    if (reference.relation === "in_body") continue;
    const type: EdgeType = reference.relation === "normative" ? "cites_normative" : "cites_informative";
    const evidence: GraphEdge["evidence"] = {
      source: "rfc_references",
      url: null,
      observed_at: input.observedAt,
    };
    if (reference.target_rfc !== null) pushEdge(reference.target_rfc, type, reference.label, evidence);
    else pushEdge(null, type, reference.label, evidence, reference.label);
  }

  for (const rfc of input.metadata.obsoletes) pushEdge(rfc, "obsoletes", "obsoletes", null);
  for (const rfc of input.metadata.obsoleted_by) pushEdge(rfc, "obsoleted_by", "obsoleted_by", null);
  for (const rfc of input.metadata.updates) pushEdge(rfc, "updates", "updates", null);
  for (const rfc of input.metadata.updated_by) pushEdge(rfc, "updated_by", "updated_by", null);

  if (input.direction === "incoming" || input.direction === "both") {
    for (const relation of input.inbound) {
      if (relation.rfc === input.rootRfc) continue;
      if (edges.length >= input.maxEdges) {
        truncated = true;
        break;
      }
      const toId = `doc:rfc-${relation.rfc}`;
      addNode(nodes, relation.rfc, input.titles.get(relation.rfc), "resolved");
      const id = `edge_${shortHash(`${toId}|${rootId}|${relation.relation}`)}`;
      if (edges.some((edge) => edge.id === id)) continue;
      edges.push({
        id,
        from: toId,
        to: rootId,
        type: "cites_normative",
        relation: relation.relation,
        evidence: relation.evidence,
      });
    }
  }

  if (nodes.size > input.maxNodes) truncated = true;

  return {
    nodes: [...nodes.values()].slice(0, input.maxNodes),
    edges,
    truncated,
    unresolved: [...new Set(unresolved)],
  };
}

function addNode(
  nodes: Map<string, GraphNode>,
  rfc: number,
  title: string | undefined,
  resolution: GraphNode["resolution"],
): void {
  const id = `doc:rfc-${rfc}`;
  if (nodes.has(id)) return;
  nodes.set(id, { id, kind: "document", rfc, title: title ?? null, resolution });
}

export function citationForReference(record: ReferenceRecord, block: Block | undefined): string | null {
  if (!block) return null;
  const first = record.cited_by[0];
  if (!first) return null;
  return citationId({
    snapshotId: record.snapshot_id,
    blockId: first.block_id,
    byteStart: first.offset,
    quote: block.text,
  });
}

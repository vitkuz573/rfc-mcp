/**
 * Deterministic document diffing.
 *
 * Text diffs are never presented as semantic diffs: `text` mode reports line
 * hunks, `requirements` mode reports modality changes, and `structure` mode
 * reports section add/remove/move/rename. Every change carries the ids needed
 * to cite both sides, and `MUST -> SHOULD` is labelled `modality_changed`, not
 * "breaking".
 */

import type { CatalogRecord, DiffChange, DiffResult, Requirement, Section } from "../core/types.js";
import { shortHash, truncateBytes } from "../core/util.js";

export type DiffMode = "text" | "structure" | "requirements" | "metadata" | "references";

export interface DiffSide {
  readonly documentId: string;
  readonly snapshotId: string;
  readonly catalog: CatalogRecord;
  readonly sections: readonly Section[];
  readonly requirements: readonly Requirement[];
  readonly references: readonly { label: string; relation: string; target: string | null }[];
  readonly lines: readonly string[];
}

const MAX_DIFF_LINES = 2000;

/**
 * What the pass actually did, as opposed to what it was asked to do.
 *
 * This exists because the explanation was being computed and thrown away. The line diff
 * gives up above a per-side ceiling, falls back to `diffStructure`, and wrote
 * `documents_too_large_for_line_diff_use_structure_mode` into a local `notes` array that
 * `DiffResult` has no field for. So `diff(5246, 8446, "text")` returned 107 changes, every
 * one of them `section_renamed` / `section_added` / `section_removed` / `section_moved`,
 * byte-identical to `mode: "structure"` on the same pair, and the only thing the caller was
 * told was that a text diff is not a semantic diff. Measured on the corpus: RFC 5246 is
 * 5 828 lines, 8446 is 8 964, 2178 is 11 820, 2328 is 12 202, 959 is 3 934 - all over the
 * ceiling, so the fallback is the normal case for `text` mode and not an edge case.
 *
 * `requested_mode` and `mode` are both here because they are the same string in every case
 * except one, and that one is the whole finding: a caller who asked for a text diff and got
 * a structural one has to be able to see that from the result, not infer it from the change
 * kinds. The numbers are here so a caller can tell "over the ceiling" from "under it, and
 * the two texts really are identical".
 *
 * `notes` keeps the machine-readable key the fallback has always used, so a caller that
 * switches on a string is not broken by this.
 */
export interface DiffRun {
  /** The mode the caller asked for. */
  readonly requested_mode: DiffMode;
  /** The mode the returned changes were produced by. Differs only on the line-diff fallback. */
  readonly mode: DiffMode;
  /** True only for `mode: "text"`, and true whether or not the ceiling stopped it. */
  readonly line_diff_attempted: boolean;
  /** False when the line diff gave up and the changes are structural. */
  readonly line_diff_within_ceiling: boolean;
  readonly left_lines: number;
  readonly right_lines: number;
  /** The ceiling itself, published so a caller can predict the fallback. */
  readonly max_lines_per_side: number;
  /** Machine-readable reasons, empty when the requested mode is the mode that ran. */
  readonly notes: readonly string[];
}

/**
 * A `DiffResult` that says what it did.
 *
 * `DiffResult` is declared in `src/core/types.ts`, which this file does not own, and the
 * fix belongs here rather than there: the knowledge is here. The added field is
 * `readonly run: DiffRun`, and whoever owns `types.ts` should add it to `DiffResult` as
 * `readonly run?: DiffRun` so that it is visible on the declared type - see the report.
 * Until then this subtype is what `diffDocuments` returns, and because it extends
 * `DiffResult` every existing caller keeps type-checking unchanged, including the one in
 * `src/service/rfcService.ts` that spreads the result and adds its own `coverage`.
 */
export interface DiffOutcome extends DiffResult {
  readonly run: DiffRun;
}

export function diffDocuments(input: {
  readonly left: DiffSide;
  readonly right: DiffSide;
  readonly mode: DiffMode;
  readonly maxChanges: number;
  readonly maxOutputBytes: number;
}): DiffOutcome {
  const changes: DiffChange[] = [];
  const summary: Record<string, number> = {};
  // The note is a return value, not a local. See `DiffRun`.
  const notes: string[] = [];
  let mode: DiffMode = input.mode;
  let lineDiffAttempted = false;
  let lineDiffWithinCeiling = true;

  const add = (
    kind: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    changeNotes: readonly string[] = [],
  ): void => {
    if (changes.length >= input.maxChanges) return;
    const id = `chg_${shortHash(`${input.mode}|${kind}|${JSON.stringify(before)}|${JSON.stringify(after)}`)}`;
    if (changes.some((change) => change.id === id)) return;
    changes.push({
      id,
      kind,
      before,
      after,
      before_citation_id: typeof before?.quote_citation_id === "string" ? before.quote_citation_id : null,
      after_citation_id: typeof after?.quote_citation_id === "string" ? after.quote_citation_id : null,
      notes: changeNotes,
    });
    summary[kind] = (summary[kind] ?? 0) + 1;
  };

  switch (input.mode) {
    case "structure": {
      diffStructure(input, add);
      break;
    }
    case "text": {
      lineDiffAttempted = true;
      const outcome = diffText(input, add);
      notes.push(...outcome.notes);
      lineDiffWithinCeiling = outcome.notes.length === 0;
      if (!lineDiffWithinCeiling) mode = "structure";
      break;
    }
    case "requirements": {
      diffRequirements(input, add);
      break;
    }
    case "metadata": {
      diffMetadata(input, add);
      break;
    }
    case "references": {
      diffReferences(input, add);
      break;
    }
  }

  return {
    left: { document_id: input.left.documentId, snapshot_id: input.left.snapshotId },
    right: { document_id: input.right.documentId, snapshot_id: input.right.snapshotId },
    mode: input.mode,
    base: "exact",
    changes,
    summary,
    truncated: changes.length >= input.maxChanges,
    run: {
      requested_mode: input.mode,
      mode,
      line_diff_attempted: lineDiffAttempted,
      line_diff_within_ceiling: lineDiffWithinCeiling,
      left_lines: input.left.lines.length,
      right_lines: input.right.lines.length,
      max_lines_per_side: MAX_DIFF_LINES,
      notes,
    },
  };
}

type AddFn = (
  kind: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  notes?: readonly string[],
) => void;

function diffStructure(input: { left: DiffSide; right: DiffSide }, add: AddFn): void {
  const leftByNumber = new Map(input.left.sections.map((section) => [section.number, section]));
  const rightByNumber = new Map(input.right.sections.map((section) => [section.number, section]));
  const leftByTitle = new Map(input.left.sections.map((section) => [section.title, section]));
  const rightByTitle = new Map(input.right.sections.map((section) => [section.title, section]));

  for (const [number, section] of leftByNumber) {
    const match = rightByNumber.get(number);
    if (!match) {
      const movedTo = [...rightByTitle.entries()].find(([, candidate]) => candidate.title === section.title);
      if (movedTo) {
        add("section_moved", sectionView(section), sectionView(movedTo[1]), [
          `matched by title; section numbering differs between documents`,
        ]);
      } else {
        add("section_removed", sectionView(section), null);
      }
      continue;
    }
    if (match.title !== section.title) {
      add("section_renamed", sectionView(section), sectionView(match));
    }
  }
  for (const [number, section] of rightByNumber) {
    if (!leftByNumber.has(number) && !leftByTitle.has(section.title)) {
      add("section_added", null, sectionView(section));
    }
  }
}

function sectionView(section: Section): Record<string, unknown> {
  return {
    number: section.number,
    title: section.title,
    kind: section.kind,
    section_id: section.id,
    snapshot_id: section.snapshot_id,
  };
}

/**
 * The line diff, or the structural diff standing in for it.
 *
 * The reason for standing in is returned, not accumulated into a local the caller cannot
 * see: see `DiffRun` for what the fallback costs and what it was measured at.
 */
function diffText(input: { left: DiffSide; right: DiffSide; maxOutputBytes: number }, add: AddFn): { notes: string[] } {
  const left = input.left.lines;
  const right = input.right.lines;
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    diffStructure(input, add);
    return {
      notes: [
        "documents_too_large_for_line_diff_use_structure_mode",
        `left_lines:${left.length}`,
        `right_lines:${right.length}`,
        `max_lines_per_side:${MAX_DIFF_LINES}`,
      ],
    };
  }
  const ops = lcsOps(left, right, (line) => line);
  let buffer: string[] = [];
  let flushing = false;
  const flush = (): void => {
    if (!flushing) return;
    const text = buffer.join("\n");
    const truncated = truncateBytes(text, input.maxOutputBytes);
    add("text_hunk", { lines: truncated.text }, null, truncated.truncated ? ["hunk_truncated"] : []);
    buffer = [];
    flushing = false;
  };
  for (const op of ops) {
    if (op.op === "equal") {
      flush();
      continue;
    }
    flushing = true;
    buffer.push(`${op.op === "remove" ? "-" : "+"} ${op.value}`);
  }
  flush();
  return { notes: [] };
}

interface DiffOp {
  readonly op: "equal" | "remove" | "add";
  readonly value: string;
}

export function lcsOps<T>(left: readonly T[], right: readonly T[], key: (item: T) => string): DiffOp[] {
  const n = left.length;
  const m = right.length;
  const leftKeys = left.map(key);
  const rightKeys = right.map(key);
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        leftKeys[i] === rightKeys[j]
          ? table[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (leftKeys[i] === rightKeys[j]) {
      ops.push({ op: "equal", value: String(left[i]) });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!) {
      ops.push({ op: "remove", value: String(left[i]) });
      i += 1;
    } else {
      ops.push({ op: "add", value: String(right[j]) });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ op: "remove", value: String(left[i]) });
    i += 1;
  }
  while (j < m) {
    ops.push({ op: "add", value: String(right[j]) });
    j += 1;
  }
  return ops;
}

function requirementKey(requirement: Requirement, sectionNumber: string): string {
  const normalized = requirement.exact_text.replace(
    /\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|SHALL|REQUIRED|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b/gu,
    "<NORMATIVE>",
  );
  return `${sectionNumber}|${normalized.replace(/\s+/gu, " ").trim()}`;
}

function diffRequirements(input: { left: DiffSide; right: DiffSide }, add: AddFn): void {
  const numberById = (side: DiffSide): Map<string, string> =>
    new Map(side.sections.map((section) => [section.id, section.number]));

  const leftNumbers = numberById(input.left);
  const rightNumbers = numberById(input.right);

  const leftByKey = new Map<string, Requirement[]>();
  const rightByKey = new Map<string, Requirement[]>();
  for (const requirement of input.left.requirements) {
    const key = requirementKey(requirement, leftNumbers.get(requirement.section_id) ?? "");
    leftByKey.set(key, [...(leftByKey.get(key) ?? []), requirement]);
  }
  for (const requirement of input.right.requirements) {
    const key = requirementKey(requirement, rightNumbers.get(requirement.section_id) ?? "");
    rightByKey.set(key, [...(rightByKey.get(key) ?? []), requirement]);
  }

  for (const [key, leftGroup] of leftByKey) {
    const rightGroup = rightByKey.get(key) ?? [];
    const leftTerms = new Set(leftGroup.map((requirement) => requirement.term));
    const rightTerms = new Set(rightGroup.map((requirement) => requirement.term));
    if (rightTerms.size === 0) {
      add("requirement_removed", requirementView(leftGroup[0]!, leftNumbers), null);
      continue;
    }
    const onlyLeft = [...leftTerms].filter((term) => !rightTerms.has(term));
    const onlyRight = [...rightTerms].filter((term) => !leftTerms.has(term));
    if (onlyLeft.length > 0 && onlyRight.length > 0) {
      add(
        "modality_changed",
        requirementView(
          leftGroup.find((item) => onlyLeft.includes(item.term))!,
          leftNumbers,
        ),
        requirementView(
          rightGroup.find((item) => onlyRight.includes(item.term))!,
          rightNumbers,
        ),
        [`${onlyLeft.join("/")} -> ${onlyRight.join("/")}`, "modality_change_is_not_a_breaking_change_verdict"],
      );
    }
  }
  for (const [key, rightGroup] of rightByKey) {
    if (leftByKey.has(key)) continue;
    add("requirement_added", null, requirementView(rightGroup[0]!, rightNumbers));
  }
}

function requirementView(requirement: Requirement, numbers: Map<string, string>): Record<string, unknown> {
  return {
    requirement_id: requirement.id,
    section: numbers.get(requirement.section_id) ?? null,
    term: requirement.term,
    strength: requirement.strength,
    polarity: requirement.polarity,
    text: requirement.exact_text,
    actor: requirement.clause.actor,
    condition: requirement.clause.condition,
    exception: requirement.clause.exception,
    parse_status: requirement.parse_status,
    confidence: requirement.confidence,
    snapshot_id: requirement.snapshot_id,
    quote_citation_id: requirement.citation_id,
  };
}

const METADATA_FIELDS: readonly (keyof CatalogRecord)[] = [
  "title",
  "abstract",
  "published",
  "status",
  "stream",
  "area",
  "group",
  "keywords",
  "authors",
  "obsoletes",
  "obsoleted_by",
  "updates",
  "updated_by",
  "subseries",
  "doi",
  "pages",
];

function diffMetadata(input: { left: DiffSide; right: DiffSide }, add: AddFn): void {
  for (const field of METADATA_FIELDS) {
    const before = input.left.catalog[field] as unknown;
    const after = input.right.catalog[field] as unknown;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    add("metadata_changed", { field, value: before }, { field, value: after });
  }
}

function diffReferences(input: { left: DiffSide; right: DiffSide }, add: AddFn): void {
  const key = (reference: { label: string; relation: string }): string => `${reference.relation}|${reference.label}`;
  const left = new Map(input.left.references.map((reference) => [key(reference), reference]));
  const right = new Map(input.right.references.map((reference) => [key(reference), reference]));
  for (const [id, reference] of left) {
    if (!right.has(id))
      add(
        "reference_removed",
        { label: reference.label, relation: reference.relation, target: reference.target },
        null,
      );
  }
  for (const [id, reference] of right) {
    if (!left.has(id))
      add("reference_added", null, { label: reference.label, relation: reference.relation, target: reference.target });
  }
  for (const [id, leftRef] of left) {
    const rightRef = right.get(id);
    if (!rightRef) continue;
    if (leftRef.target !== rightRef.target) {
      add(
        "reference_target_changed",
        { label: leftRef.label, target: leftRef.target },
        { label: rightRef.label, target: rightRef.target },
      );
    }
  }
}

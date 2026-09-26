// Builds the golden set: 100 protocols, ~3 labelled rules each.
//
// Labels come from document text through the same MCP surface the measurement uses
// (eval/lib/mcp.mjs -> tools named exactly as the server registers them), so a probe is
// a snippet of what `read` returns and nothing else. The extractor is never consulted
// while labelling: `requirements` is not called anywhere in this file, which is what
// keeps the recall number from being circular.
//
//   node eval/build-golden.mjs            # writes eval/golden.json
//   node eval/build-golden.mjs --dry      # report counts, write nothing
//
// Snapshots are pinned and recorded per protocol. A golden set that does not name the
// bytes it was cut from cannot be re-verified after a re-sync, and this corpus changes
// under the bench.

import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";
import {
  danglingHeadings,
  RULES_PER_PROTOCOL,
  rulesFromSection,
  sectionProbeOrder,
  SKIP_KINDS_FOR_PROBE,
} from "./lib/labelling.mjs";

const STRATA = 10;
const PER_STRATUM = 10;
const DRY = process.argv.includes("--dry");

/** Deterministic stratified sample of the corpus: STRATA equal slices, PER_STRATUM evenly spaced. */
function pickProtocols(rfcs) {
  const picked = [];
  for (let k = 0; k < STRATA; k += 1) {
    const a = Math.floor((k * rfcs.length) / STRATA);
    const b = Math.floor(((k + 1) * rfcs.length) / STRATA);
    const seg = rfcs.slice(a, b);
    for (let i = 0; i < PER_STRATUM; i += 1) {
      picked.push(seg[Math.round((i * (seg.length - 1)) / (PER_STRATUM - 1))]);
    }
  }
  return [...new Set(picked)];
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const { mcp } = await connect();
const corpus = JSON.parse(readFileSync("eval/corpus.json", "utf8"));
const picked = pickProtocols(corpus.documents.map((d) => d.rfc));

const protocols = [];
const rules = [];
const diagnostics = [];

const results = await mapLimit(picked, 4, async (rfc) => {
  const note = { rfc, problems: [] };
  const resolved = await mcp.call("resolve", { rfc });
  if (resolved.__error || !resolved.data?.snapshot?.id) {
    note.problems.push(`resolve failed: ${(resolved.__error ?? "no snapshot").slice(0, 120)}`);
    return { rfc, note };
  }
  const snapshot_id = resolved.data.snapshot.id;
  const title = resolved.data.document?.title ?? "";
  const published = resolved.data.document?.published ?? null;

  const outlineRes = await mcp.call("read", {
    snapshot_id,
    target: "outline",
    include: ["outline"],
    max_output_bytes: 200000,
  });
  const sections = Array.isArray(outlineRes.data?.outline) ? outlineRes.data.outline : [];
  if (sections.length === 0) {
    note.problems.push("outline empty");
    return { rfc, note };
  }

  const cache = new Map();
  const textFor = async (section) => {
    if (cache.has(section.number)) return cache.get(section.number);
    const res = await mcp.call("read", {
      snapshot_id,
      section: section.number,
      include: ["text"],
      max_output_bytes: 60000,
    });
    const payload = {
      text: res.data?.text ?? "",
      truncated: res.data?.truncated === true,
      verbatim: res.data?.text_verbatim ?? null,
      furniture: res.data?.page_furniture_lines ?? [],
    };
    cache.set(section.number, payload);
    return payload;
  };

  // `chooseSection` is synchronous, so drive the same order here explicitly rather
  // than reading three sections per protocol when the middle one is enough.
  const eligible = sections.filter((s) => s.number !== "" && !SKIP_KINDS_FOR_PROBE.has(s.kind));
  const order = sectionProbeOrder(eligible.length);

  // Sample outward from the middle until the protocol has its quota of rules, or the
  // probe order runs out. More than one section per protocol is what keeps a document
  // that keeps its obligations in one place from contributing all of them, and what
  // gives a document with obligations in five places a fair sample.
  const perSection = [];
  const collected = [];
  const tried = [];
  for (const idx of order) {
    const section = eligible[idx];
    if (!section) continue;
    const payload = await textFor(section);
    const found = rulesFromSection(payload.text, section.number);
    tried.push({ section: section.number, rules: found.length, truncated: payload.truncated });
    perSection.push({
      section: section.number,
      rules: found.length,
      text: payload.text,
      furniture: payload.furniture,
      truncated: payload.truncated,
      section_obj: section,
    });
    for (const r of found) {
      if (collected.length >= RULES_PER_PROTOCOL) break;
      collected.push(r);
    }
    if (collected.length >= RULES_PER_PROTOCOL) break;
  }

  if (collected.length === 0) {
    note.problems.push(`no eligible sentence in sections ${tried.map((t) => t.section).join(",")}`);
    return {
      rfc,
      note,
      snapshot_id,
      title,
      published,
      tried,
      perSection,
      eligible_count: eligible.length,
      outline_sections: sections.length,
      outline_numbers: sections.map((s) => s.number),
    };
  }

  return {
    rfc,
    note,
    snapshot_id,
    title,
    published,
    collected,
    perSection,
    tried,
    eligible_count: eligible.length,
    outline_sections: sections.length,
    outline_numbers: sections.map((s) => s.number),
  };
});

for (const r of results) {
  if (!r || r.note.problems.some((p) => p.startsWith("resolve failed"))) {
    diagnostics.push(r?.note ?? { rfc: "?", problems: ["no result"] });
    continue;
  }
  if (!r.collected || r.collected.length === 0) {
    diagnostics.push({ ...r.note, eligible_sections: r.eligible_count, probed: r.tried });
    protocols.push({
      rfc: r.rfc,
      title: r.title,
      published: r.published,
      snapshot_id: r.snapshot_id,
      sections_used: [],
      rules: 0,
      eligible_sections: r.eligible_count,
      outline_sections: r.outline_sections,
      dangling_headings: [],
    });
    continue;
  }
  for (const rule of r.collected) {
    const id = `G${String(rules.length + 1).padStart(4, "0")}`;
    rules.push({ id, rfc: r.rfc, ...rule });
  }
  const used = r.perSection.filter((s) => s.rules > 0);
  protocols.push({
    rfc: r.rfc,
    title: r.title,
    published: r.published,
    snapshot_id: r.snapshot_id,
    sections_used: used.map((s) => s.section),
    rules: r.collected.length,
    eligible_sections: r.eligible_count,
    outline_sections: r.outline_sections,
    sections_probed: r.tried.length,
    sections_with_rules: used.length,
    // Label-free: subsection headings the sampled text shows and the outline omits.
    // Non-empty means statements under those headings are unreachable, and no amount
    // of querying this tool returns them.
    dangling_headings: danglingHeadings(used.map((s) => s.text).join("\n"), r.outline_numbers ?? []),
  });
}

const byTier = (t) => rules.filter((x) => x.tier === t).length;
const byClass = (c) => rules.filter((x) => x.class === c).length;

const out = {
  $meta: {
    title: "Golden set: 100 protocols, labelled normative statements, for the RFC -> contract -> code scenario.",
    built_at: new Date().toISOString().slice(0, 10),
    protocols: protocols.length,
    rules: rules.length,
    strict: byTier("strict"),
    weak: byTier("weak"),
    by_class: {
      "uppercase-modal": byClass("uppercase-modal"),
      "lowercase-modal": byClass("lowercase-modal"),
      "keyword-free-spec": byClass("keyword-free-spec"),
    },
    protocol_selection: `${STRATA} equal strata of the corpus by RFC number, ${PER_STRATUM} evenly spaced per stratum. No document is added, dropped or reordered by hand, so the bench cannot drift toward a family the extractor happens to handle.`,
    section_selection:
      "Numbered sections sampled outward from the middle of the document (1/2, 1/4, 3/4, 1/8, 7/8, 3/8, 5/8) until the protocol has three rules or the order runs out. Prose-only kinds are skipped; appendices are not, because appendices hold the field definitions a keyword-driven pass misses.",
    labelling:
      "A candidate is any sentence carrying a modal token matched case-insensitively (must|shall|should|may|required|recommended|optional). Tier is derived from case alone: an upper-case RFC 2119/8174 keyword makes it strict, anything else weak. Selection never looks at case, and no rule is ever taken from the extractor's output.",
    matching:
      "Whitespace-normalised substring containment, applied to probe and candidate alike, because RFC text is hard-wrapped and exact_text keeps the line breaks. Verdicts are reported both ways: normalised and byte-exact.",
    tier_separation:
      "strict is matched ONLY against requirements[].exact_text and weak ONLY against non_strict_candidates.candidates[].exact_text. A provisional hit never counts as a normative one; mixing the two would inflate recall by construction.",
  },
  protocols: protocols.sort((a, b) => a.rfc - b.rfc),
  rules,
};

if (!DRY) writeFileSync("eval/golden.json", `${JSON.stringify(out, null, 1)}\n`);

console.log(
  `protocols: ${protocols.length}  rules: ${rules.length}  strict: ${out.$meta.strict}  weak: ${out.$meta.weak}`,
);
console.log(JSON.stringify(out.$meta.by_class));
console.log(
  `protocols with no rule: ${
    protocols
      .filter((p) => p.rules === 0)
      .map((p) => p.rfc)
      .join(" ") || "none"
  }`,
);
const dangling = protocols.filter((p) => (p.dangling_headings ?? []).length > 0);
console.log(`protocols whose sampled section shows a subsection heading the outline omits: ${dangling.length}`);
for (const p of dangling.slice(0, 12))
  console.log(
    `  rfc ${p.rfc} (sampled ${p.sections_used.join(",")}): ${p.dangling_headings.length} dangling -> ${p.dangling_headings
      .slice(0, 12)
      .map((h) => h.number)
      .join(" ")}`,
  );
if (diagnostics.length > 0) console.log(`diagnostics: ${JSON.stringify(diagnostics, null, 1)}`);
if (DRY) console.log("(dry run: nothing written)");

await mcp.close();
process.exit(0);

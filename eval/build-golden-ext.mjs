// The supplementary golden set: the protocols the main bench could not sample.
//
// Five of the 100 protocols in eval/golden.json produced ZERO rules, and the reason was
// a defect, not the documents. `danglingHeadings` in eval/lib/labelling.mjs found 63
// subsection numbers across RFC 959, 1122, 1123 and 2300 that the outline did not list,
// because pre-2010 RFCs set their subsection titles by indenting them and the heading
// finder treated every indented line as body text. The bench samples sections FROM the
// outline, so it was blind to those titles by construction - and RFC 768 went further and
// had no addressable structure at all, its entire body sitting in one section called
// "Front Matter".
//
// That blindness is the reason this file exists. A golden set cut from a broken outline
// cannot measure the repair of the thing that broke the outline, so the five empty
// protocols are sampled again here, AFTER the fix, from an outline that now lists them.
// Fifty-nine further documents are ingested and outside the main set; they are included
// so the supplementary measurement is not five data points either.
//
//   node eval/build-golden-ext.mjs
//
// The numbers this produces are NOT comparable with the main bench's before/after, and
// the file says so. It has no "before": the documents it covers could not be sampled
// before. What it can answer is whether a document the parser could not reach yields
// normative statements once it can - which is the question the fix was made to answer.

import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";
import { RULES_PER_PROTOCOL, rulesFromSection, sectionProbeOrder, SKIP_KINDS_FOR_PROBE, whyFor } from "./lib/labelling.mjs";

const corpus = JSON.parse(readFileSync("eval/corpus.json", "utf8"));
const main = JSON.parse(readFileSync("eval/golden.json", "utf8"));
const inMain = new Set(main.protocols.map((p) => p.rfc));
const emptyInMain = main.protocols.filter((p) => p.rules === 0).map((p) => p.rfc);
const targets = corpus.documents.map((d) => d.rfc).filter((rfc) => !inMain.has(rfc) || emptyInMain.includes(rfc));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const { mcp } = await connect();

const results = await mapLimit(targets, 4, async (rfc) => {
  const resolved = await mcp.call("resolve", { rfc });
  const snapshot_id = resolved.data?.snapshot?.id ?? null;
  if (!snapshot_id) return { rfc, problem: "no snapshot" };
  const outline = await mcp.call("read", {
    snapshot_id,
    target: "outline",
    include: ["outline"],
    max_output_bytes: 400000,
  });
  const sections = Array.isArray(outline.data?.outline) ? outline.data.outline : [];
  const eligible = sections.filter((s) => s.number !== "" && !SKIP_KINDS_FOR_PROBE.has(s.kind));
  if (eligible.length === 0) return { rfc, snapshot_id, problem: "no addressable section" };

  const collected = [];
  const perSection = [];
  for (const idx of sectionProbeOrder(eligible.length)) {
    if (collected.length >= RULES_PER_PROTOCOL) break;
    const section = eligible[idx];
    const res = await mcp.call("read", {
      snapshot_id,
      section: section.number,
      include: ["text"],
      max_output_bytes: 60000,
    });
    const text = res.data?.text ?? "";
    const found = rulesFromSection(text, section.number);
    perSection.push({ section: section.number, rules: found.length, blocks: res.data?.blocks?.length ?? null });
    for (const rule of found) {
      if (collected.length >= RULES_PER_PROTOCOL) break;
      collected.push({ rfc, snapshot_id, ...rule, why: whyFor(rule.tier, rule.kw, rule.section) });
    }
  }
  return {
    rfc,
    snapshot_id,
    title: resolved.data?.document?.title ?? "",
    published: resolved.data?.document?.published ?? null,
    outline_sections: sections.length,
    eligible_sections: eligible.length,
    sections_probed: perSection,
    rules: collected,
  };
});

const usable = results.filter((r) => !r.problem);
const protocols = usable.map((r) => ({
  rfc: r.rfc,
  title: r.title,
  published: r.published,
  snapshot_id: r.snapshot_id,
  outline_sections: r.outline_sections,
  eligible_sections: r.eligible_sections,
  sections_probed: r.sections_probed.length,
  rules: r.rules.length,
  was_unsampleable: emptyInMain.includes(r.rfc),
}));
let nextId = 1;
const rules = usable.flatMap((r) =>
  r.rules.map((rule) => {
    const id = `X${String(nextId).padStart(4, "0")}`;
    nextId += 1;
    return { id, ...rule };
  }),
);

const byTier = (t) => rules.filter((r) => r.tier === t).length;
const out = {
  $meta: {
    title: "Supplementary golden set: the documents the main bench could not sample.",
    built_at: new Date().toISOString().slice(0, 10),
    comparable_with_main_bench: false,
    why_not:
      "There is no before. These documents had no addressable structure before the parser fix, so no probe could be cut from them and no rule could be missed. A before/after pair here would be a number with nothing behind it.",
    protocols: protocols.length,
    rules: rules.length,
    strict: byTier("strict"),
    weak: byTier("weak"),
    previously_unsampleable: protocols.filter((p) => p.was_unsampleable).map((p) => p.rfc),
    what_it_measures:
      "Whether a document the parser could not reach yields normative statements once it can. The five protocols with zero rules in the main bench are here for that reason, plus every other ingested document outside the main set, so the answer is not five data points.",
    labelling: "Identical to eval/golden.json, and the functions are shared: eval/lib/labelling.mjs.",
  },
  protocols: protocols.sort((a, b) => a.rfc - b.rfc),
  rules,
};

writeFileSync("eval/golden-ext.json", `${JSON.stringify(out, null, 1)}\n`);
const empty = protocols.filter((p) => p.rules === 0).map((p) => p.rfc);
console.log(`supplementary: ${protocols.length} protocols, ${rules.length} rules (${out.$meta.strict} strict / ${out.$meta.weak} weak)`);
console.log(`previously unsampleable: ${out.$meta.previously_unsampleable.join(" ") || "none"}`);
console.log(`still no rules: ${empty.join(" ") || "none"}`);
for (const r of [768, 792, 8448, 9650].filter((r) => out.$meta.previously_unsampleable.includes(r))) {
  const p = protocols.find((x) => x.rfc === r);
  console.log(`  rfc${r}: outline ${p.eligible_sections} addressable sections -> ${p.rules} rules`);
}
await mcp.close();
process.exit(0);

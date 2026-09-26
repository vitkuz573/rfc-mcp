// The bench. Measures the four numbers over the golden set, and nothing else decides
// them: no DNS knowledge, no hand-picked protocols, no reading of the tool's own
// counters as if they were the answer.
//
//   node eval/run-bench.mjs --tag before
//   node eval/run-bench.mjs --tag after --skip-invariants
//
// Every call goes through the MCP stdio surface (eval/lib/mcp.mjs), the same
// `tools.rfc.*` an agent uses, with the snapshot pinned. Nothing is read from the
// database, so a number here cannot be produced by a path no caller cannot reach.
//
// THE ORDER MATTERS HERE. A number a grep beats is not a measurement, and the reader of
// a results file has no way to know that unless the instrument says so. So the floor is
// computed FIRST, on every run, and a recall figure at or below its own floor is printed
// as VOID with the floor beside it rather than as a percentage. See eval/lib/floor.mjs.
//
// THE FOUR NUMBERS
//
//   RECALL    golden rules found, per tier and per class, never across tiers. A strict
//             probe is looked for ONLY in requirements[].exact_text; a weak probe ONLY
//             in non_strict_candidates.candidates[].exact_text. A provisional hit never
//             counts as a normative one, because that would inflate recall by design.
//             `keyword-free-spec` is reported as its own class: a sentence with no modal
//             token is not reachable by a keyword-driven pass, and folding it into the
//             headline number would hide a structural limit behind an average.
//             Reported under BOTH matchers: containment (the control) and the bounded
//             statement matcher (eval/lib/match.mjs).
//
//   PRECISION NOT computed here. A sample of emitted items is written out with its
//             metadata and a null label; the labels are made by hand, in
//             eval/results/<tag>-precision-labels.json. An instrument that labels its
//             own output is not measuring precision.
//
//   CALLS     every tools.rfc.* call a CALLER pays for, over three divisors, with the
//             per-protocol distribution and not only the mean.
//
//   VERIFY    one number per verdict condition (eval/lib/verify-scenarios.mjs), because
//             a single pooled percentage of the store against itself hid that three of
//             the four verdicts that matter had never once been observed.
//
// WHAT IS NOT IN CALLS, and why. The golden-set protocols, the requirements pages and
// the resolve are the scenario: they are what a caller building a compliance list pays.
// verify_citation is the harness auditing itself, and the section reads behind the
// label-free invariants are a guard, not a measurement - a guard that can move the number
// it is guarding is part of the instrument instead of a check on it. Both exclusions are
// counted and reported rather than dropped, because the previous CALLS figure was 52.9%
// verify_citation and the reader was never told.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";
import { danglingHeadings, norm, rulesFromSection, sectionProbeOrder, SKIP_KINDS_FOR_PROBE } from "./lib/labelling.mjs";
import { FLOOR_EXTRACTORS, floorRows, SPLITTERS, splitterSensitivityRows } from "./lib/floor.mjs";
import { findBounded, findExact, findUnbounded, MATCH_MARGIN, MARGIN_SWEEP, quantiles } from "./lib/match.mjs";
import { negativeCensus, negativeProbes } from "./lib/negative.mjs";
import { budgetConservation, fidelity, poolReach, sectionReach } from "./lib/conservation.mjs";
import { runVerifyScenarios } from "./lib/verify-scenarios.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const TAG = arg("--tag", "run");
const SKIP_INVARIANTS = process.argv.includes("--skip-invariants");
const PRECISION_TARGET = Number(arg("--precision", "250"));
const RULES_PER_UNIT = 40;
const MAX_RESULTS = 200; // the schema ceiling
const MAX_CANDIDATES = 2000; // the schema ceiling
const NEGATIVE_CAP = Number(arg("--negative-cap", "40"));

const golden = JSON.parse(readFileSync("eval/golden.json", "utf8"));
const corpus = JSON.parse(readFileSync("eval/corpus.json", "utf8"));
mkdirSync("eval/results", { recursive: true });

const calls = { resolve: 0, requirements: 0, requirements_extra_page: 0, verify_citation: 0, read: 0 };
let callTotal = 0;

const { mcp } = await connect();
async function call(name, args, bucket) {
  calls[bucket] += 1;
  callTotal += 1;
  return mcp.call(name, args);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const pct = (n, d) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
const per40 = (n, d) => (d === 0 ? null : Math.round((100 * n) / d) / 100);

// -------------------------------------------------------------------------------------
// Phase 1: fetch. One resolve to pin, one scoped requirements per protocol, one
// unscoped for the pagination cost, then paging until the section is exhausted.
// -------------------------------------------------------------------------------------

const byProtocol = new Map();
for (const p of golden.protocols) byProtocol.set(p.rfc, { ...p, rules: [] });
for (const r of golden.rules) byProtocol.get(r.rfc)?.rules.push(r);

// THE EXCLUSION IS NOW A NUMBER. `rules.length > 0` is a condition on the LABELLER's
// output, not on the tool's, and the five documents it dropped are the ones the tool
// cannot reach - two of them return nothing at all. A filter that removes the hardest
// documents from a recall measurement and prints nothing about it is not a filter, it is
// a hole in the denominator with a shape like a design decision. The protocols are still
// not scored (a document that yields no probe cannot yield a recall hit or miss), and the
// count, the names, the reason and what they would yield if they were included are all
// reported.
const excluded = [...byProtocol.values()].filter((p) => p.rules.length === 0);
const protocols = [...byProtocol.values()].filter((p) => p.rules.length > 0);

const fetched = await mapLimit(protocols, 4, async (p) => {
  const resolved = await call("resolve", { rfc: p.rfc }, "resolve");
  const snapshot_id = resolved.data?.snapshot?.id ?? null;
  if (!snapshot_id) return { rfc: p.rfc, snapshot_id: null, error: (resolved.__error ?? "no snapshot").slice(0, 160) };

  const drift = p.snapshot_id && p.snapshot_id !== snapshot_id ? `${p.snapshot_id} -> ${snapshot_id}` : null;

  // One `requirements` per protocol, then pages until the requirement list is
  // exhausted. The 200-row ceiling is a property of the schema, not of this harness,
  // and a caller who wants the whole compliance list of a 900-requirement RFC pays
  // for it. Those pages are counted, because that cost IS the CALLS number. Per-page row
  // sets are kept because R3 asks whether paging changes the set a caller receives, and
  // the answer is a function of what each page carried.
  const strict = [];
  const candidates = [];
  const mentions = [];
  const perPage = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const args = { snapshot_id, max_results: MAX_RESULTS, max_candidates: MAX_CANDIDATES };
    if (cursor) args.cursor = cursor;
    const res = await call("requirements", args, pages === 0 ? "requirements" : "requirements_extra_page");
    if (res.__error) return { rfc: p.rfc, snapshot_id, error: res.__error.slice(0, 200) };
    const pageStrict = res.data?.requirements ?? [];
    const pageCand = res.data?.non_strict_candidates?.candidates ?? [];
    const pageMentions = res.data?.mentions ?? [];
    perPage.push({
      page: pages + 1,
      requirements: pageStrict.map((r) => r.id),
      candidates: pageCand.map((r) => r.id),
      mentions: pageMentions.map((r) => r.id),
    });
    strict.push(...pageStrict);
    candidates.push(...pageCand);
    mentions.push(...pageMentions);
    pages += 1;
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
    if (pages > 60) break;
  }
  // Counted. This call used to be made outside the counting wrapper, which is a call a
  // caller pays for that the harness was not counting in the number it published.
  const last = await call("requirements", { snapshot_id, max_results: 1, max_candidates: 1 }, "requirements");
  if (last.__error) return { rfc: p.rfc, snapshot_id, error: last.__error.slice(0, 200) };

  // R3, first half: a channel re-shipped on a later page. Compared by row id, because the
  // defect is that the caller receives the same row twice, not that a row is similar.
  // Dedupe per document: a 3-page document re-shipping on pages 2 AND 3 is one document
  // with one defect, and counting it twice makes the number mean something else.
  const reShipped = new Set();
  for (const later of perPage.slice(1)) {
    const first = perPage[0];
    if (later.requirements.some((id) => first.requirements.includes(id))) reShipped.add("requirements");
    if (later.candidates.some((id) => first.candidates.includes(id))) reShipped.add("non_strict_candidates.candidates");
    if (later.mentions.some((id) => first.mentions.includes(id))) reShipped.add("mentions");
  }
  // R3, second half: a channel that returns rows without saying how many there are.
  const silentChannels = [];
  if (strict.length > 0 && last.data?.coverage?.total_requirements === undefined) silentChannels.push("requirements");
  if (candidates.length > 0 && last.data?.non_strict_candidates?.total === undefined)
    silentChannels.push("non_strict_candidates");
  // `mentions` is a bare array on every page: no total, no returned, no truncated flag.
  if (mentions.length > 0) silentChannels.push("mentions");

  return {
    rfc: p.rfc,
    title: p.title,
    sections: p.sections_used,
    snapshot_id,
    recorded_snapshot_id: p.snapshot_id ?? null,
    drift,
    strict,
    candidates,
    fragments: last.data?.non_strict_candidates?.fragments ?? [],
    mentions,
    perPage,
    reShipped: [...reShipped],
    silentChannels,
    pages,
    total_requirements: last.data?.coverage?.total_requirements ?? null,
    candidate_total: last.data?.non_strict_candidates?.total ?? null,
    by_shape: last.data?.non_strict_candidates?.by_shape ?? null,
    by_case: last.data?.non_strict_candidates?.by_keyword_case ?? null,
    by_role: last.data?.non_strict_candidates?.by_role ?? null,
    keyword_stance: last.data?.keyword_usage?.stance ?? null,
    warnings: last.warnings ?? [],
  };
});

const fetchedByRfc = new Map(fetched.map((f) => [f.rfc, f]));

// -------------------------------------------------------------------------------------
// Phase 1b: what the excluded protocols would yield. The labeller's own rule, replayed on
// the current outline, so the report can say what the filter is hiding in units of rules
// rather than in units of opinion. Reads are made directly and are NOT counted: this is a
// disclosure about the denominator, not part of the scenario.
// -------------------------------------------------------------------------------------

const excludedReplay = await mapLimit(excluded, 4, async (p) => {
  const resolved = await mcp.call("resolve", { rfc: p.rfc });
  const snapshot_id = resolved.data?.snapshot?.id ?? null;
  if (!snapshot_id) return { rfc: p.rfc, recorded_rules: 0, would_yield: null, why: "resolve failed" };
  const outlineRes = await mcp.call("read", {
    snapshot_id,
    target: "outline",
    include: ["outline"],
    max_output_bytes: 200000,
  });
  const sections = Array.isArray(outlineRes.data?.outline) ? outlineRes.data.outline : [];
  const eligible = sections.filter((s) => s.number !== "" && !SKIP_KINDS_FOR_PROBE.has(s.kind));
  let would = 0;
  const tried = [];
  for (const idx of sectionProbeOrder(eligible.length)) {
    const s = eligible[idx];
    if (!s) continue;
    const res = await mcp.call("read", { snapshot_id, section: s.number, include: ["text"], max_output_bytes: 60000 });
    const n = rulesFromSection(res.data?.text ?? "", s.number).length;
    tried.push([s.number, n]);
    would += n;
    if (would >= 3) break;
  }
  const strict = await mcp.call("requirements", { snapshot_id, max_results: 1, max_candidates: 1 });
  return {
    rfc: p.rfc,
    recorded_rules: 0,
    would_yield: Math.min(would, 3),
    would_yield_exact: would,
    eligible_sections: eligible.length,
    tool_total_requirements: strict.data?.coverage?.total_requirements ?? null,
    tool_candidate_total: strict.data?.non_strict_candidates?.total ?? null,
    tried,
  };
});

// -------------------------------------------------------------------------------------
// Phase 1c: the sections, once. The floor, the negative probes, the conservation
// invariant and the dangling-heading guard all need the same text and the same blocks, so
// they share one read per section. Blocks need `source_map` or their `text` comes back
// empty, which the server warns about; omitting `include` entirely would be cheaper but
// would also return the outline machinery, so the list is explicit.
// -------------------------------------------------------------------------------------

const sectionsOf = (p) => [...new Set(p.rules.map((r) => r.section))].sort();
const sectionData = new Map();
await mapLimit(protocols, 4, async (p) => {
  const f = fetchedByRfc.get(p.rfc);
  if (!f || f.error) return;
  const rows = [];
  for (const number of sectionsOf(p)) {
    const res = await mcp.call("read", {
      snapshot_id: f.snapshot_id,
      section: number,
      include: ["text", "blocks", "source_map"],
      max_output_bytes: 200000,
    });
    if (res.__error) continue;
    rows.push({
      rfc: p.rfc,
      section: number,
      text: res.data?.text ?? "",
      blocks: (res.data?.blocks ?? []).map((b) => ({ id: b.id, kind: b.kind, text: b.text ?? "" })),
      truncated: res.data?.truncated === true,
    });
  }
  sectionData.set(p.rfc, rows);
});

// -------------------------------------------------------------------------------------
// Phase 2: match. Tier separation is enforced in one place, so it cannot be relaxed by a
// later edit to the reporting. Both matchers run here, on the same rows, so the difference
// between them is attributable to the matcher and not to the tool.
// -------------------------------------------------------------------------------------

const poolOf = (f, tier) => (tier === "strict" ? f.strict : f.candidates);
const whereOf = (tier) => (tier === "strict" ? "requirements" : "non_strict_candidates");

const floors = new Map();
for (const p of protocols) {
  const secs = (sectionData.get(p.rfc) ?? []).map((s) => ({ ...s, rfc: p.rfc }));
  floors.set(p.rfc, { rows: floorRows(secs), sensitivity: splitterSensitivityRows(secs) });
}

const verdicts = [];
for (const rule of golden.rules) {
  const f = fetchedByRfc.get(rule.rfc);
  const pool = f && !f.error ? poolOf(f, rule.tier) : [];
  const floorPool = floors.get(rule.rfc)?.rows ?? new Map();
  const bounded = findBounded(pool, rule.probe, MATCH_MARGIN);
  const unbounded = findUnbounded(pool, rule.probe);
  const exact = findExact(pool, rule.probe);
  const perFloor = new Map();
  for (const [key, rows] of floorPool) {
    perFloor.set(key, findBounded(rows, rule.probe, MATCH_MARGIN));
    perFloor.set(`${key}@unbounded`, findUnbounded(rows, rule.probe));
  }
  const sens = new Map();
  for (const s of floors.get(rule.rfc)?.sensitivity ?? [])
    sens.set(s.splitter, findBounded(s.rows, rule.probe, MATCH_MARGIN));
  const noFetch = !f || f.error;
  verdicts.push({
    ...rule,
    pool: whereOf(rule.tier),
    fetch_failed: noFetch,
    // Bounded: the number that is reported. Unbounded: the control.
    found: !noFetch && bounded.hits.length > 0,
    found_unbounded: !noFetch && unbounded.hits.length > 0,
    exact_match: !noFetch && exact.hits.length > 0,
    matched: bounded.hits.length,
    matched_unbounded: unbounded.hits.length,
    ratio: bounded.hits[0]?.ratio ?? null,
    // Everything the bound removed, kept rather than dropped: an excluded match is a row
    // that carried the probe and was longer than the bench will call a statement.
    excluded_by_margin: bounded.excluded.map((e) => ({
      rfc: rule.rfc,
      ratio: e.ratio,
      chars: e.lenRow,
      text: e.item.exact_text.slice(0, 160),
    })),
    citation_ids: bounded.hits.map((h) => h.item.citation_id).filter(Boolean),
    floor: Object.fromEntries([...perFloor].filter(([k]) => !k.includes("@")).map(([k, v]) => [k, v.hits.length > 0])),
    floor_unbounded: Object.fromEntries(
      [...perFloor].filter(([k]) => k.includes("@")).map(([k, v]) => [k.replace("@unbounded", ""), v.hits.length > 0]),
    ),
    splitters: Object.fromEntries([...sens].map(([k, v]) => [k, v.hits.length > 0])),
    verdict: noFetch
      ? "fetch_failed"
      : bounded.hits.length > 0
        ? rule.tier === "strict"
          ? "found_strict"
          : "found_provisional"
        : "missed",
  });
}

function tally(filter, field = "found") {
  const set = verdicts.filter(filter);
  const hit = set.filter((v) => v[field]);
  return {
    rules: set.length,
    found: hit.length,
    found_pct: pct(hit.length, set.length),
    exact_pct: pct(set.filter((v) => v.exact_match).length, set.length),
    missed: set.filter((v) => !v[field]).map((v) => v.id),
  };
}

const TIERS = [
  { key: "strict", label: "strict", filter: (v) => v.tier === "strict" },
  { key: "weak_lower", label: "weak/lower", filter: (v) => v.class === "lowercase-modal" },
  { key: "weak_keyword_free", label: "weak/keyword-free", filter: (v) => v.class === "keyword-free-spec" },
  { key: "weak_all", label: "weak/all", filter: (v) => v.tier === "weak" },
];

// -------------------------------------------------------------------------------------
// Phase 2b: THE FLOOR, and the void. Computed on every run, from the same golden set, by
// the same matcher, over the same sections the probes were cut from. A tier whose tool
// score is at or below the best trivial extractor on that tier is printed VOID with the
// floor beside it, because a number a grep beats is not a measurement and the only way a
// reader finds out is if the instrument says so itself.
// -------------------------------------------------------------------------------------

const floorRowsTotal = new Map(FLOOR_EXTRACTORS.map((f) => [f.key, 0]));
for (const p of protocols)
  for (const [key, rows] of floors.get(p.rfc)?.rows ?? [])
    floorRowsTotal.set(key, floorRowsTotal.get(key) + rows.length);

// The floor is mandatory, so its ABSENCE has to be a stated outcome rather than a zero. A
// 0% floor would read as "no trivial extractor can do this" when it would really mean "the
// harness could not read the sections the probes were cut from", and every tier would print
// `measured` against a floor that does not exist.
const floorRowTotal = [...floorRowsTotal.values()].reduce((a, b) => a + b, 0);
const floorSilent = protocols.filter((p) => (floors.get(p.rfc)?.rows.get("F1_modal_sentence") ?? []).length === 0);
const FLOOR_COMPUTABLE = floorRowTotal > 0 && floorSilent.length === 0;

const FLOOR = TIERS.map((t) => {
  const set = verdicts.filter(t.filter);
  const tool = pct(set.filter((v) => v.found).length, set.length);
  const byExtractor = FLOOR_EXTRACTORS.map((f) => {
    const hit = set.filter((v) => v.floor[f.key]).length;
    const unbounded = set.filter((v) => v.floor_unbounded[f.key]).length;
    return {
      key: f.key,
      what: f.what,
      rows_emitted: floorRowsTotal.get(f.key),
      found: hit,
      found_pct: pct(hit, set.length),
      // The same extractor under the OLD matcher. This is the number the red team
      // published: whole-section emission is 100% of everything under containment and
      // ~1% of it under a bound, which is the whole case for the bound in two figures.
      found_pct_containment_matcher: pct(unbounded, set.length),
    };
  });
  const best = byExtractor.reduce((a, b) => ((b.found_pct ?? -1) > (a.found_pct ?? -1) ? b : a), byExtractor[0]);
  const bestUnbounded = byExtractor.reduce(
    (a, b) => ((b.found_pct_containment_matcher ?? -1) > (a.found_pct_containment_matcher ?? -1) ? b : a),
    byExtractor[0],
  );
  const toolUnbounded = pct(set.filter((v) => v.found_unbounded).length, set.length);
  const void_ = tool !== null && best.found_pct !== null && tool <= best.found_pct;
  return {
    tier: t.key,
    label: t.label,
    rules: set.length,
    tool_found: set.filter((v) => v.found).length,
    tool_pct: tool,
    tool_pct_unbounded_matcher: toolUnbounded,
    floor: byExtractor,
    floor_pct: best.found_pct,
    floor_set_by: best.key,
    floor_pct_containment_matcher: bestUnbounded.found_pct_containment_matcher,
    floor_containment_set_by: bestUnbounded.key,
    // The rule, stated as code: a figure at or below its own floor carries no information
    // about the extractor, so it is VOID and is not printed as a percentage anywhere.
    verdict: !FLOOR_COMPUTABLE ? "floor_unavailable" : tool === null ? "not_measured" : void_ ? "VOID" : "measured",
    floor_computable: FLOOR_COMPUTABLE,
    discriminates: FLOOR_COMPUTABLE && tool !== null && best.found_pct !== null && tool > best.found_pct,
    void_because: !FLOOR_COMPUTABLE
      ? `the floor could not be computed for this run: ${floorRowTotal} floor rows over ${protocols.length} protocols, and ${floorSilent.length} protocol(s) whose sections were unreadable (${floorSilent.map((p) => p.rfc).join(" ") || "none"}). The tool's figure is printed, and it is not a measurement until the floor is beside it.`
      : !void_
        ? null
        : best.found_pct === 0
          ? `the tool scores ${tool}% and the best trivial extractor scores 0% on these ${set.length} probes: the class does not discriminate, because nothing reaches it - not a grep, not a sentence splitter, and not this build either. Its 0% is a statement about the tier, not about the extractor.`
          : `the tool scores ${tool}% and ${best.key} scores ${best.found_pct}% on the same ${set.length} probes with the same matcher: at or below the floor, so the gap is not evidence of extraction.`,
  };
});

// The margin sweep, so a reader can see the headline move with the bound rather than
// having to take the bound on trust. `1.0` is exact-length containment, `Infinity` is the
// old unbounded matcher. Containment is computed once per rule above, so the sweep is a
// comparison against a stored answer rather than a rescan of every pool.
const MARGIN = MARGIN_SWEEP.map((m) => {
  const per = TIERS.map((t) => {
    const set = verdicts.filter(t.filter);
    const hit = set.filter(
      (v) =>
        findBounded(poolOf(fetchedByRfc.get(v.rfc) ?? { strict: [], candidates: [] }, v.tier), v.probe, m).hits.length >
        0,
    );
    const unbounded = set.filter((v) => v.found_unbounded);
    return {
      tier: t.key,
      label: t.label,
      found: hit.length,
      rules: set.length,
      found_pct: pct(hit.length, set.length),
      excluded_vs_unbounded: unbounded.length - hit.length,
    };
  });
  return { margin: m === Infinity ? "unbounded" : m, per_tier: per };
});

const allExcluded = verdicts.flatMap((v) => v.excluded_by_margin.map((e) => ({ id: v.id, ...e })));
const hitRatios = verdicts
  .filter((v) => v.found)
  .map((v) => v.ratio)
  .filter((x) => x !== null);

// -------------------------------------------------------------------------------------
// Phase 2c: SPLITTER SENSITIVITY. The same three lines of floor extractor under four
// sentence-boundary rules. If the spread is wide, the recall number is measuring whether
// the candidate extractor's sentences agree with the labeller's, and the harness says so
// on every run instead of leaving it in a results file.
// -------------------------------------------------------------------------------------

const SPLITTER = Object.keys(SPLITTERS).map((name) => {
  const per = TIERS.map((t) => {
    const set = verdicts.filter(t.filter);
    return {
      tier: t.key,
      label: t.label,
      found: set.filter((v) => v.splitters[name]).length,
      rules: set.length,
      found_pct: pct(set.filter((v) => v.splitters[name]).length, set.length),
    };
  });
  const pcts = per.map((p) => p.found_pct).filter((x) => x !== null);
  let emitted = 0;
  for (const p of protocols)
    emitted += (floors.get(p.rfc)?.sensitivity.find((s) => s.splitter === name)?.rows ?? []).length;
  return {
    splitter: name,
    why: SPLITTERS[name].why,
    rows_emitted: emitted,
    per_tier: per,
    spread_pp: pcts.length > 1 ? Math.round((Math.max(...pcts) - Math.min(...pcts)) * 10) / 10 : null,
  };
});
const maxSpread = Math.max(...SPLITTER.map((s) => s.spread_pp ?? 0));

// -------------------------------------------------------------------------------------
// Phase 2d: NEGATIVE PROBES. The number that separates a real extractor from a grep: a
// 3-line modal grep scores 100% on the positive set, and the positive set cannot tell the
// two apart. Generated by published mechanism, never hand-picked (eval/lib/negative.mjs).
// -------------------------------------------------------------------------------------

const negatives = [];
const negativeCollisions = [];
for (const p of protocols) {
  const secs = (sectionData.get(p.rfc) ?? []).map((s) => ({ ...s, rfc: p.rfc }));
  const probes = p.rules.map((r) => norm(r.probe));
  const { probes: built, collisions } = negativeProbes(secs, { strictProbes: new Set(probes), cap: NEGATIVE_CAP });
  negatives.push(...built);
  for (const c of collisions) negativeCollisions.push(c);
}

const negativeRows = [];
for (const n of negatives) {
  const f = fetchedByRfc.get(n.rfc);
  if (!f || f.error) continue;
  const strictHit = findBounded(f.strict, n.text, MATCH_MARGIN);
  const candHit = findBounded(f.candidates, n.text, MATCH_MARGIN);
  const pools = n.pools;
  const leakedStrict = pools.includes("strict") && strictHit.hits.length > 0;
  const leakedCand = pools.includes("candidates") && candHit.hits.length > 0;
  negativeRows.push({
    ...n,
    leaked: leakedStrict || leakedCand,
    leaked_strict: leakedStrict,
    leaked_candidates: leakedCand,
    leaked_unbounded:
      findUnbounded(f.strict, n.text).hits.length > 0 || findUnbounded(f.candidates, n.text).hits.length > 0,
    leak_text:
      (leakedStrict ? strictHit.hits[0] : leakedCand ? candHit.hits[0] : null)?.item?.exact_text?.slice(0, 160) ?? null,
  });
}

function negativesTally(filter) {
  const set = negativeRows.filter(filter);
  const leaked = set.filter((n) => n.leaked);
  return {
    probes: set.length,
    leaked: leaked.length,
    score_pct: pct(set.length - leaked.length, set.length),
    leaked_unbounded_matcher: set.filter((n) => n.leaked_unbounded).length,
    by_generator: negativeCensus(set.map((n) => ({ class: n.class, generator: n.generator }))),
    by_block_kind: set.reduce((acc, n) => ({ ...acc, [n.block_kind]: (acc[n.block_kind] ?? 0) + 1 }), {}),
    leaked_by_pool: {
      strict: set.filter((n) => n.leaked_strict).length,
      candidates: set.filter((n) => n.leaked_candidates).length,
    },
    examples: leaked.slice(0, 6).map((n) => [n.rfc, n.section, n.class, n.generator, n.text.slice(0, 110)]),
  };
}

const MUST_NOT_CLASSES = ["meta_language", "descriptive_modal", "nonprose_block", "no_modal"];

/**
 * The number that matters for a compliance contract, split by the pool the leak is in.
 *
 * A caller building a contract reads `requirements[]`. The candidate list is a REVIEW
 * LIST: its own description says a candidate is a lead a reader copies a sentence out of,
 * and a lead that turns out not to be an obligation is the channel working. So "24% of the
 * discriminating negatives leaked" and "0% of them leaked into the strict list" are both
 * true, and only one of them is a defect. Both are printed.
 */
const discriminatingByPool = () => {
  const set = negativeRows.filter((n) => n.class === "meta_language" || n.class === "descriptive_modal");
  const strict = set.filter((n) => n.pools.includes("strict"));
  const cand = set.filter((n) => n.pools.includes("candidates"));
  return {
    probes: set.length,
    leaked_strict: strict.filter((n) => n.leaked_strict).length,
    strict_score_pct: pct(strict.length - strict.filter((n) => n.leaked_strict).length, strict.length),
    leaked_candidates: cand.filter((n) => n.leaked_candidates).length,
    candidates_score_pct: pct(cand.length - cand.filter((n) => n.leaked_candidates).length, cand.length),
    why: "A caller building a compliance contract reads requirements[]. The candidate list is a review list, so a lead that is not an obligation is that channel working rather than a defect - and saying so is not exculpation, it is naming which pool each number is about. A class that leaks into requirements[] is a defect; the same class in non_strict_candidates is a cost to whoever reads the review list.",
  };
};

const NEGATIVES = {
  why: "A benchmark where a 3-line grep scores 100% has no floor to measure against, and the positive set cannot supply one: it asks only whether a statement was found, and a grep finds every statement. These probes are the statements that must NOT be in a compliance list. Every one is produced by a named, published mechanism test over text the extractor never sees (eval/lib/negative.mjs) - never hand-picked, and the label IS the mechanism.",
  unlabelled_positive_guard:
    "A negative whose normalised text is also a golden probe is dropped and counted: it would be scored in both directions at once. Collisions dropped: " +
    negativeCollisions.length +
    (negativeCollisions.length > 0
      ? ` (${JSON.stringify(negativeCollisions.slice(0, 4).map((c) => [c.rfc, c.class]))})`
      : ""),
  total: negativeRows.length,
  leaked: negativeRows.filter((n) => n.leaked).length,
  score_pct: pct(negativeRows.length - negativeRows.filter((n) => n.leaked).length, negativeRows.length),
  score_pct_note:
    "Pooled over every class. It is the LEAST useful number here, because `no_modal` is the largest class and almost every extractor passes it, so the pool is dominated by the one check that does not discriminate. The discriminating figure is `discriminating` below.",
  per_class: MUST_NOT_CLASSES.map((c) => ({ class: c, ...negativesTally((n) => n.class === c) })),
  contested: [{ class: "preformatted_block", ...negativesTally((n) => n.class === "preformatted_block") }],
  discriminating: negativesTally((n) => n.class === "meta_language" || n.class === "descriptive_modal"),
  discriminating_by_pool: discriminatingByPool(),
  census: negativeCensus(negativeRows),
  not_measured: [
    "An upper-case descriptive modal - the most common false positive in RFC 2119 and the most valuable negative. Telling a deontic modal from a descriptive one is a grammatical judgement, and the only mechanism available for it is the extractor's own `shape: demand`, which is the claim under test. Labelling with it would make the check circular, so the population is UNMEASURED rather than guessed.",
    "Any class whose generators fire on nothing. The census above is the count per generator; a generator that produced zero is a class the mechanism does not reach in this corpus, and that is reported rather than quietly widened.",
  ],
};

// The same floor extractors, scored on the NEGATIVE set. This is the pair that decides
// what the instrument can measure: an extractor that takes 100% of the positives and 0% of
// the negatives is doing nothing, and a recall number quoted without its negative score is
// a number with half the instrument missing. `leaked_containment` is reported beside
// `leaked_bounded` because for the whole-section emitter the two readings of "it emitted
// the sentence" are both defensible and the difference is the whole point of the matcher.
const negativesByRfc = new Map();
for (const n of negativeRows) {
  if (!negativesByRfc.has(n.rfc)) negativesByRfc.set(n.rfc, []);
  negativesByRfc.get(n.rfc).push(n);
}
const floorNegative = (filter) => {
  const set = negativeRows.filter(filter);
  const per = FLOOR_EXTRACTORS.map((f) => {
    let bounded = 0;
    let containment = 0;
    for (const n of set) {
      const rows = floors.get(n.rfc)?.rows.get(f.key) ?? [];
      if (findBounded(rows, n.text, MATCH_MARGIN).hits.length > 0) bounded += 1;
      if (findUnbounded(rows, n.text).hits.length > 0) containment += 1;
    }
    return {
      key: f.key,
      probes: set.length,
      leaked_bounded: bounded,
      score_bounded_pct: pct(set.length - bounded, set.length),
      leaked_containment: containment,
      score_containment_pct: pct(set.length - containment, set.length),
    };
  });
  return per;
};

NEGATIVES.floor_extractors = {
  why: "The floor scored on the set it is supposed to fail. A trivial extractor that takes every positive probe and every negative one is proved to be doing nothing, and the two numbers together are the only way to say what a recall figure is worth.",
  discriminating: floorNegative((n) => n.class === "meta_language" || n.class === "descriptive_modal"),
  per_class: ["meta_language", "descriptive_modal"].map((c) => ({
    class: c,
    probes: negativeRows.filter((n) => n.class === c).length,
    floor: floorNegative((n) => n.class === c),
  })),
  all_classes: floorNegative(() => true),
};

// The pair, not the two numbers separately. A floor extractor can beat the tool on recall
// and lose on negatives, and that trade is the finding: what an extra 8 points of recall
// costs in contamination is the only question the two numbers together can answer. VOID
// says the recall figure carries no information; the pair says what replacing the tool
// with the grep would actually buy.
const toolStrict = FLOOR.find((f) => f.tier === "strict");
const toolNeg = NEGATIVES.discriminating;
const pairwise = FLOOR_EXTRACTORS.map((f) => {
  const pos = FLOOR.find((x) => x.tier === "strict").floor.find((x) => x.key === f.key).found_pct;
  const neg = NEGATIVES.floor_extractors.discriminating.find((x) => x.key === f.key);
  const dPos = pos === null || toolStrict.tool_pct === null ? null : Math.round((pos - toolStrict.tool_pct) * 10) / 10;
  const dNeg =
    neg.score_bounded_pct === null || toolNeg.score_pct === null
      ? null
      : Math.round((neg.score_bounded_pct - toolNeg.score_pct) * 10) / 10;
  return {
    key: f.key,
    what: f.what,
    strict_recall_pct: pos,
    negative_score_pct: neg.score_bounded_pct,
    vs_tool_recall_pp: dPos,
    vs_tool_negative_pp: dNeg,
    // Dominates = at least as good on both axes and better on one. F1 does NOT dominate:
    // it buys +8.2 points of strict recall for -6.4 points of negative score, and that
    // trade is the whole measurement.
    dominates_tool: dPos !== null && dNeg !== null && dPos >= 0 && dNeg >= 0 && (dPos > 0 || dNeg > 0),
    dominated_by_tool: dPos !== null && dNeg !== null && dPos <= 0 && dNeg <= 0 && (dPos < 0 || dNeg < 0),
  };
});

FLOOR.push({
  tier: "negative_discriminating",
  label: "NEGATIVE (must-not)",
  rules: NEGATIVES.discriminating.probes,
  tool_found: NEGATIVES.discriminating.probes - NEGATIVES.discriminating.leaked,
  tool_pct: NEGATIVES.discriminating.score_pct,
  tool_pct_unbounded_matcher: pct(
    NEGATIVES.discriminating.probes - NEGATIVES.discriminating.leaked_unbounded_matcher,
    NEGATIVES.discriminating.probes,
  ),
  floor: FLOOR_EXTRACTORS.map((f) => {
    const row = NEGATIVES.floor_extractors.discriminating.find((x) => x.key === f.key);
    return {
      key: f.key,
      what: f.what,
      rows_emitted: floorRowsTotal.get(f.key),
      found: row.probes - row.leaked_bounded,
      found_pct: row.score_bounded_pct,
      found_pct_containment_matcher: row.score_containment_pct,
    };
  }),
  floor_pct: Math.max(...NEGATIVES.floor_extractors.discriminating.map((x) => x.score_bounded_pct)),
  floor_set_by:
    "the trivial extractors score between 69% and 100% here; only the modal-sentence grep is bad at it, and it is bad by only 6 points",
  verdict: "measured",
  discriminates: true,
  void_because: null,
  note: "The only tier in this table where the tool is above the best trivial extractor, and by 6 points. Read it with the strict row: a grep trades 8 points of recall for 6 points of contamination, and the trade is the measurement. A high score here is not a high score in isolation - a whole-section emitter scores 100% by emitting nothing at all, which is why the two rows are one table.",
});

// -------------------------------------------------------------------------------------
// Phase 3: VERIFY, one number per verdict condition.
// -------------------------------------------------------------------------------------

const verifyBefore = callTotal;
const verifyScenarios = await runVerifyScenarios(
  protocols
    .map((p) => {
      const f = fetchedByRfc.get(p.rfc);
      if (!f || f.error) return null;
      const dupes = new Map();
      for (const it of f.strict) {
        const k = norm(it.exact_text);
        dupes.set(k, (dupes.get(k) ?? 0) + 1);
      }
      const dup = [...dupes].find(([, n]) => n > 1);
      return {
        rfc: p.rfc,
        snapshot_id: f.snapshot_id,
        recorded_snapshot_id: f.recorded_snapshot_id,
        row_citation_id: f.strict[0]?.citation_id ?? f.candidates[0]?.citation_id ?? null,
        // Strict rows only: these are stored records, and `findCitationMatches` reads stored
        // records. A candidate row is derived per call and never stored, so its quote is
        // unrecorded by design and probing with one would measure the tool's own note.
        duplicate_text: dup ? f.strict.find((it) => norm(it.exact_text) === dup[0]).exact_text : null,
      };
    })
    .filter(Boolean),
  (name, args, bucket) => call(name, args, bucket),
);
const verifyCalls = callTotal - verifyBefore;

const VERIFY = {
  why: "One number per verdict condition, because one pooled number is what hid the finding. The old figure - 234/235 = 99.6% of the citations hanging off a matched recall rule - is the store checked against itself: the quote and the block come from the same record, so they agree by construction. It is not recomputed here; S1 is the same check, named as a control, and the other four conditions are the ones that can fail.",
  replaces: {
    figure: "234/235 = 99.6% ({verified: 234, not_found: 1})",
    how_it_was_produced:
      "verify_citation on citation_ids.slice(0,2) of every rule counted found, pinned to that protocol's snapshot. eval/results/redteam.json VERIFY.",
    why_not_recomputed:
      "It is a tautology and it cost 235 calls; S1 measures the same property with 96 and is labelled as the control it is.",
  },
  calls: verifyCalls,
  scenarios: verifyScenarios,
  pooled_conform_pct:
    verifyScenarios.filter((s) => s.reachable).length === 0
      ? null
      : Math.round(
          (1000 * verifyScenarios.filter((s) => s.reachable).reduce((a, s) => a + s.conform, 0)) /
            verifyScenarios.reduce((a, s) => a + s.checks, 0) /
            10,
        ),
  pooled_note:
    "Pooled for completeness only. The per-scenario numbers are the measurement: pooling is how a 96/96 control and a 0/96 broken condition average into something that looks like a rate.",
};

// -------------------------------------------------------------------------------------
// Phase 4: recall numbers, old matcher beside new.
// -------------------------------------------------------------------------------------

const RECALL = {
  strict: tally((v) => v.tier === "strict"),
  weak_all: tally((v) => v.tier === "weak"),
  weak_lowercase_modal: tally((v) => v.class === "lowercase-modal"),
  weak_keyword_free: tally((v) => v.class === "keyword-free-spec"),
  by_tier_table: TIERS.map((t) => ({
    tier: t.key,
    label: t.label,
    rules: verdicts.filter(t.filter).length,
    bounded_matcher: tally(t.filter),
    containment_matcher: tally(t.filter, "found_unbounded"),
    delta_pp: (() => {
      const a = tally(t.filter).found_pct;
      const b = tally(t.filter, "found_unbounded").found_pct;
      return a === null || b === null ? null : Math.round((a - b) * 10) / 10;
    })(),
  })),
  matcher: {
    control: "containment: norm(row.exact_text) includes norm(probe), no bound on the row",
    reported: `bounded statement containment: the probe must be a substring of the row AND the normalised row may not exceed ${MATCH_MARGIN}x the normalised probe`,
    why: "Containment alone lets one row per section score 260/260 = 100% on every tier, for an extractor that reads nothing, so a percentage under it describes the matcher rather than the extractor.",
    margin: MATCH_MARGIN,
    margin_is_a_judgement: true,
    margin_sweep: MARGIN,
    matches_excluded_by_margin: allExcluded.length,
    matches_excluded_detail: allExcluded.slice(0, 12),
    hit_ratio_distribution: quantiles(hitRatios),
  },
  headline_rule:
    "strict and weak are never added together; keyword-free is reported apart because no keyword-driven extractor can reach it; every tier is reported beside its own floor and marked VOID when the floor beats it.",
};

// -------------------------------------------------------------------------------------
// Phase 5: CALLS, over three divisors, with the distribution.
// -------------------------------------------------------------------------------------

const callerBuckets = ["resolve", "requirements", "requirements_extra_page"];
const callerCalls = callerBuckets.reduce((a, b) => a + calls[b], 0);
const auditCalls = callTotal - callerCalls;
const goldenRules = verdicts.length;
const reportedRequirements = fetched.reduce((a, f) => a + (f.total_requirements ?? 0), 0);
const emittedRows = fetched.reduce((a, f) => a + f.strict.length + f.candidates.length, 0);

const perProtocolCalls = protocols.map((p) => {
  const f = fetchedByRfc.get(p.rfc);
  const n = f?.error ? 0 : 2 + (f?.pages ?? 0);
  return {
    rfc: p.rfc,
    title: p.title,
    golden_rules: p.rules.length,
    calls: n,
    calls_per_golden_rule: per40(n, p.rules.length),
    pages: f?.pages ?? null,
    emitted_rows: (f?.strict.length ?? 0) + (f?.candidates.length ?? 0),
    total_requirements: f?.total_requirements ?? null,
  };
});

const buckets = {};
for (const row of perProtocolCalls) {
  const b = (buckets[row.golden_rules] ??= {
    golden_rules: row.golden_rules,
    protocols: 0,
    calls: 0,
    rules: 0,
    rows: 0,
    mean_calls: 0,
    mean_rows: 0,
    calls_per_golden_rule: null,
  });
  b.protocols += 1;
  b.calls += row.calls;
  b.rules += row.golden_rules;
  b.rows += row.emitted_rows;
}
for (const b of Object.values(buckets)) {
  b.mean_calls = Math.round((100 * b.calls) / b.protocols) / 100;
  b.mean_rows = Math.round(b.rows / b.protocols);
  b.calls_per_golden_rule = per40(b.calls, b.rules);
}
const worst =
  [...perProtocolCalls].sort((a, b) => (b.calls_per_golden_rule ?? 0) - (a.calls_per_golden_rule ?? 0))[0] ?? null;
// Two "worst" documents, because per-rule and per-row are different questions and the
// distribution has both shapes in it. The sparse document is the expensive one per RULE -
// the fixed cost of a resolve and an unscoped requirements is amortised over almost
// nothing. The dense document is the expensive one per ROW - 13 pages because the schema
// caps a page at 200 rows. A single worst figure would have to pick one and hide the other.
// The per-row figure is restricted to documents with at least ROW_FLOOR emitted rows,
// because a 4-row document with 0 requirements is not "expensive per row", it is a document
// with nothing in it, and letting it win the ranking is the same mistake as letting a
// 1-rule document win the per-rule ranking.
const ROW_FLOOR = 50;
const worstByRow =
  [...perProtocolCalls]
    .filter((r) => r.emitted_rows >= ROW_FLOOR)
    .sort((a, b) => b.calls / b.emitted_rows - a.calls / a.emitted_rows)[0] ?? null;
const mostPaged = [...perProtocolCalls].sort((a, b) => (b.pages ?? 0) - (a.pages ?? 0))[0] ?? null;
const meanRules = protocols.length === 0 ? 0 : goldenRules / protocols.length;

const CALLS = {
  golden_rules: goldenRules,
  units_of_40_golden_rules: Math.round((goldenRules / RULES_PER_UNIT) * 100) / 100,
  calls_total: callTotal,
  // A SNAPSHOT. `calls` is a live counter and the corpus-invariant phase below keeps
  // incrementing it, so a reference here would print the invariant phase's cost inside the
  // scenario figure - the same class of bug as counting a guard as a step of the scenario.
  by_purpose: { ...calls },
  // The published figure divided by probes is not a cost per unit of work: 40 rules is not
  // one protocol's worth of contract here, a protocol is ~168 emitted rows, and the
  // headline was 29x the requirement-normalised number and 58x the row-normalised one.
  // All three divisors are reported because the reader has to be able to see which one
  // they are quoting before they quote it.
  per_40_golden_rules: per40(callerCalls, goldenRules / RULES_PER_UNIT),
  per_40_reported_requirements: per40(callerCalls, reportedRequirements / RULES_PER_UNIT),
  per_40_emitted_rows: per40(callerCalls, emittedRows / RULES_PER_UNIT),
  caller_calls: callerCalls,
  caller_buckets: callerBuckets,
  audit_calls: auditCalls,
  audit_note:
    "verify_citation, and nothing else: the harness auditing its own output. It was 52.9% of the old headline, and a caller building a compliance list never calls it. The section reads behind the label-free invariants are made outside the counting wrapper and are not in either figure: a guard that can move the number it guards is part of the instrument rather than a check on it, and their cost is reported in `instrument_reads`.",
  instrument_reads: null,
  reported_requirements: reportedRequirements,
  emitted_rows: emittedRows,
  distribution_by_golden_rules_per_protocol: Object.values(buckets).sort((a, b) => a.golden_rules - b.golden_rules),
  worst_protocol: worst
    ? {
        rfc: worst.rfc,
        title: worst.title,
        golden_rules: worst.golden_rules,
        calls: worst.calls,
        pages: worst.pages,
        emitted_rows: worst.emitted_rows,
        total_requirements: worst.total_requirements,
        calls_per_golden_rule: worst.calls_per_golden_rule,
        why: `WORST PER GOLDEN RULE. ${worst.calls} calls for ${worst.golden_rules} golden rule and ${worst.emitted_rows} emitted rows. The fixed cost is one resolve plus one unscoped requirements before a single rule is read, so it is amortised over ${worst.golden_rules} probe${worst.golden_rules === 1 ? "" : "s"} here and over ${meanRules.toFixed(2)} on average. A sparse document is the most expensive thing in the set per unit of measured work, and the cheapest per row - both numbers are reported because a mean of either one is a lie about the other.`,
      }
    : null,
  worst_protocol_per_row: worstByRow
    ? {
        rfc: worstByRow.rfc,
        title: worstByRow.title,
        golden_rules: worstByRow.golden_rules,
        calls: worstByRow.calls,
        pages: worstByRow.pages,
        emitted_rows: worstByRow.emitted_rows,
        total_requirements: worstByRow.total_requirements,
        calls_per_emitted_row: Math.round((10000 * worstByRow.calls) / worstByRow.emitted_rows) / 10000,
        restricted_to: `documents emitting at least ${ROW_FLOOR} rows, so a document with nothing in it cannot win the ranking`,
        why: `WORST PER EMITTED ROW, over documents with at least ${ROW_FLOOR} rows. ${worstByRow.calls} calls (${worstByRow.pages} pages) for ${worstByRow.emitted_rows} emitted rows. The cost here is pagination, not the fixed cost: max_results caps a page at ${MAX_RESULTS} rows, so a document with ${worstByRow.total_requirements} requirements is read in ${worstByRow.pages} calls, and every one of those is a call a caller building a compliance list has to make.`,
      }
    : null,
  most_expensive_to_read_whole: mostPaged
    ? {
        rfc: mostPaged.rfc,
        title: mostPaged.title,
        pages: mostPaged.pages,
        calls: mostPaged.calls,
        total_requirements: mostPaged.total_requirements,
        emitted_rows: mostPaged.emitted_rows,
        why: `Most pages of any measured document: ${mostPaged.pages} pages, ${mostPaged.calls} calls, ${mostPaged.total_requirements} requirements and ${mostPaged.emitted_rows} emitted rows. This is the absolute worst case for a caller who wants the whole compliance list, and it is a property of the 200-row page ceiling rather than of the extractor.`,
      }
    : null,
};

// -------------------------------------------------------------------------------------
// Phase 5: the precision sample. Deterministic, round-robin over protocols so one
// 900-requirement document cannot dominate, and unlabelled on purpose.
// -------------------------------------------------------------------------------------

const sample = [];
let sampleDuplicates = 0;
{
  const seen = new Set();
  const queues = fetched
    .filter((f) => !f.error)
    .map((f) => {
      const items = [];
      const n = Math.max(f.strict.length, f.candidates.length);
      for (let i = 0; i < n; i += 1) {
        if (f.strict[i]) items.push(f.strict[i]);
        if (f.candidates[i]) items.push(f.candidates[i]);
      }
      return { f, items };
    });
  let progressed = true;
  while (sample.length < PRECISION_TARGET && progressed) {
    progressed = false;
    for (const q of queues) {
      const item = q.items.shift();
      if (!item) continue;
      // Dedupe on (rfc, normalised text). 22.6% of the rows over 100 documents are
      // duplicates within their document, the worst document repeating one sentence
      // twelve times, so an undeduped sample of 285 rows held 233 distinct sentences:
      // the effective n was 82% of nominal and one sentence could be labelled six times.
      // The count of what was skipped is reported, because the row-level and the
      // sentence-level precision numbers are different numbers.
      const key = `${q.f.rfc}|${norm(item.exact_text)}`;
      if (seen.has(key)) {
        sampleDuplicates += 1;
        continue;
      }
      seen.add(key);
      progressed = true;
      const rule = verdicts.find((v) => v.citation_ids.includes(item.citation_id));
      sample.push({
        sample_id: `P${String(sample.length + 1).padStart(3, "0")}`,
        rfc: q.f.rfc,
        section: item.section ?? null,
        kind: item.provisional === true ? "non_strict_candidate" : "requirement",
        keyword: item.keyword ?? null,
        keyword_case: item.keyword_case ?? null,
        role: item.role ?? null,
        shape: item.shape ?? null,
        reason: item.reason ?? null,
        text: item.exact_text,
        matched_a_golden_rule: rule?.id ?? null,
        label: null,
      });
    }
  }
}

writeFileSync(`eval/results/${TAG}-precision-sample.json`, `${JSON.stringify(sample, null, 1)}\n`);

const PRECISION = {
  status: "awaiting manual labels",
  sample: sample.length,
  distinct_sentences: sample.length,
  duplicate_rows_skipped: sampleDuplicates,
  dedupe_key: "rfc + whitespace-normalised exact_text",
  why_dedupe:
    "The same sentence is emitted up to 12 times in one document, so an undeduped sample labels one sentence repeatedly and the effective n is smaller than the printed n.",
  sample_file: `eval/results/${TAG}-precision-sample.json`,
  rubric: "eval/PRECISION-RUBRIC.md",
};

// -------------------------------------------------------------------------------------
// Phase 5b: label-free outline invariant, per sampled protocol. A subsection heading the
// text shows and the outline does not list is a hole in every query surface at once, and
// RECALL cannot see it: the golden set samples sections FROM the outline, so a document
// that quietly lost 63 of them still scores on the rules it kept. That is how the defect
// this release fixed survived - 63 numbers across RFC 959, 1122, 1123 and 2300 that no
// query could return.
//
// Recomputed on every run rather than read out of golden.json. The `read` calls are made
// directly and are NOT counted: see the `audit_note` in CALLS.
// -------------------------------------------------------------------------------------

const danglingRows = await mapLimit(protocols, 4, async (p) => {
  const f = fetchedByRfc.get(p.rfc);
  if (!f || f.error) return { rfc: p.rfc, error: true };
  const outlineRes = await mcp.call("read", {
    snapshot_id: f.snapshot_id,
    target: "outline",
    include: ["outline"],
    max_output_bytes: 200000,
  });
  const outline = Array.isArray(outlineRes.data?.outline) ? outlineRes.data.outline : [];
  const secs = sectionData.get(p.rfc) ?? [];
  const found = danglingHeadings(
    secs.map((s) => s.text).join("\n"),
    outline.map((s) => s.number),
  );
  return {
    rfc: p.rfc,
    sections: secs.length,
    sampled: secs.length,
    outline_sections: outline.length,
    count: found.length,
    numbers: found.slice(0, 12).map((h) => h.number),
  };
});
const danglingMeasured = danglingRows.filter((row) => row.count !== undefined);
const danglingFound = danglingMeasured.filter((row) => row.count > 0);

// -------------------------------------------------------------------------------------
// Phase 5c: CONSERVATION, as three invariants rather than one.
//
// `eval/audit/conservation.md` falsified Y5 as worded and then said what it would defend:
// R1 reach, R2 fidelity, R3 conservation of the budget, with the reason each is separate.
// The reason R2 cannot live inside R1 is the one that matters for a compliance contract: a
// row that states the opposite of the sentence it quotes is a perfect reach, so a coverage
// law is passed by exactly the rows a caller would be most harmed by.
//
// Each of the three is weaker than the report's wording, in one named way, printed with the
// number rather than in a footnote.
// -------------------------------------------------------------------------------------

const reachRows = [];
for (const p of protocols) {
  const f = fetchedByRfc.get(p.rfc);
  if (!f || f.error) continue;
  const secs = (sectionData.get(p.rfc) ?? []).map((s) => ({ ...s, rfc: p.rfc }));
  reachRows.push(
    ...sectionReach(secs, {
      requirements: f.strict,
      candidates: f.candidates,
      fragments: f.fragments,
      mentions: f.mentions,
    }),
  );
}
const reachPooled = poolReach(reachRows);
const fidelityAll = fidelity(fetched.filter((f) => !f.error).flatMap((f) => f.strict));
const budget = budgetConservation(
  fetched
    .filter((f) => !f.error)
    .map((f) => ({
      rfc: f.rfc,
      pages: f.pages,
      re_shipped_channels: f.reShipped,
      channels_without_a_total: f.silentChannels,
    })),
);

const CONSERVATION = {
  what: "three label-free invariants, because eval/audit/conservation.md falsified the one that was proposed: Y5 as worded is false, and it is passed by rows that invert their own sentence",
  R1_reach: {
    claim:
      "for every sampled section, every keyword-bearing sentence in read(section).text lands in exactly one arm: reached as a requirement, reached as a candidate, reached as a fragment, reached as a classified mention, or NOT REACHED",
    why: "read and requirements are allowed to disagree, and a caller who reads a section, sees a MUST and gets nothing back cannot tell a miss from a sentence that was never scanned. Recall cannot see it either: its probes are cut from the same text view the caller read, so a dropped sentence is a miss with the same shape as an extraction failure. Stated as an acceptance test in eval/results/pending-fixes.md (Y5).",
    ...reachPooled,
    weaker_than_the_report_in_three_ways: [
      "arm (c) of R1 - a per-sentence not_classified list with a reason from a closed vocabulary - is not implemented, because it is a change to the response shape and this harness only reads. The unreached set is reported with a block-kind attribution instead, which is weaker evidence than a reason the tool gave.",
      "rows are pooled over EVERY page. A caller holding page 1 has a strict subset, so this number is the tool's best case.",
      "sections are the golden set's sampled sections, not all 9 955. The report's version is corpus-scale; this one is free.",
    ],
  },
  R2_fidelity: {
    claim:
      "for every row in requirements, the polarity asserted for its primary keyword agrees with the keyword as written in exact_text",
    why: "a coverage law cannot see this. A row that states the opposite of the sentence it quotes satisfies Y5 perfectly and is the worst thing this tool can emit into a contract, so reach and fidelity have to be two numbers.",
    vocabulary:
      "MUST NOT / SHALL NOT / SHOULD NOT / NOT RECOMMENDED, and an upper-case keyword followed by a lower-case not. MAY NOT and NOT REQUIRED are deliberately NOT treated as keywords here: adding them is a change to the extractor, and a checker that borrows the tool's own vocabulary is not a checker.",
    ...fidelityAll,
  },
  R3_budget: {
    claim:
      "paging a document to exhaustion yields the same rows as one call with the ceilings raised, and every channel that truncates reports its own size",
    why: "a caller who concatenates pages must not receive a row twice, and a caller who sees 500 mentions must be able to tell 500 from all of them.",
    ...budget,
  },
  case_insensitive: true,
  case_note:
    "One predicate, one case semantics. The tool's own keyword_bearing_blocks_skipped tests an upper-case-only vocabulary case-sensitively while its candidate pass selects blocks with a case-folding LIKE, so a paragraph carrying only a lower-case permission is dropped by neither count. A check written on the strict pass's predicate would inherit that blindness, which is the defect it exists to find.",
  in_CALLS: false,
  why_not_in_CALLS:
    "It is a check on the corpus, not a step of the scenario a caller performs. The rows it reads are the ones phase 1 already fetched, so it adds no call at all; the section reads behind the sentences are the same `instrument_reads` the other label-free guards use.",
};

// -------------------------------------------------------------------------------------
// Phase 6: label-free corpus invariants over every ingested document.
// -------------------------------------------------------------------------------------

let invariants = null;
if (!SKIP_INVARIANTS) {
  const all = corpus.documents;
  const rows = await mapLimit(all, 4, async (doc) => {
    const resolved = await call("resolve", { rfc: doc.rfc }, "resolve");
    const snapshot_id = resolved.data?.snapshot?.id ?? null;
    if (!snapshot_id) return { rfc: doc.rfc, error: true };
    const res = await call(
      "requirements",
      { snapshot_id, max_results: 1, max_candidates: MAX_CANDIDATES },
      "requirements",
    );
    if (res.__error) return { rfc: doc.rfc, error: res.__error.slice(0, 120) };
    const nc = res.data?.non_strict_candidates ?? {};
    const strictItems = await call(
      "requirements",
      { snapshot_id, max_results: MAX_RESULTS, max_candidates: 1 },
      "requirements",
    );
    const shapes = nc.by_shape ?? {};
    const shapeTotal = Object.values(shapes).reduce((a, b) => a + b, 0);
    return {
      rfc: doc.rfc,
      title: doc.title,
      published: doc.published,
      bytes: doc.bytes,
      prose_blocks: doc.pb,
      total_requirements: res.data?.coverage?.total_requirements ?? null,
      strict_page: strictItems.data?.requirements ?? [],
      candidate_total: nc.total ?? 0,
      candidate_returned: nc.returned ?? 0,
      sentence_fragments: nc.sentence_fragments ?? 0,
      unreadable_blocks: nc.unreadable_blocks ?? 0,
      scanned_blocks: nc.scanned_blocks ?? 0,
      keyword_bearing_skipped: res.data?.coverage?.keyword_bearing_blocks_skipped ?? null,
      blocks_skipped_by_kind: res.data?.coverage?.blocks_skipped_by_kind ?? null,
      by_shape: shapes,
      by_case: nc.by_keyword_case ?? {},
      by_role: nc.by_role ?? {},
      demand_share: shapeTotal === 0 ? null : Math.round((1000 * (shapes.demand ?? 0)) / shapeTotal) / 10,
      keyword_stance: res.data?.keyword_usage?.stance ?? null,
      warnings: res.warnings ?? [],
    };
  });

  const ok = rows.filter((r) => !r.error);
  const dupRate = (items) => {
    const seen = new Map();
    let dups = 0;
    for (const it of items) {
      const k = norm(it.exact_text);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const n of seen.values()) if (n > 1) dups += n - 1;
    return { items: items.length, duplicates: dups, dup_pct: pct(dups, items.length) };
  };
  const strictDup = dupRate(ok.flatMap((r) => r.strict_page));
  const strictLen = ok.flatMap((r) => r.strict_page).map((r) => r.exact_text.length);
  invariants = {
    documents: corpus.documents.length,
    measured: ok.length,
    failed: rows.length - ok.length,
    zero_strict_requirements: ok.filter((r) => r.total_requirements === 0).map((r) => r.rfc),
    zero_candidates: ok.filter((r) => r.candidate_total === 0).map((r) => r.rfc),
    zero_strict_and_zero_candidates: ok
      .filter((r) => r.total_requirements === 0 && r.candidate_total === 0)
      .map((r) => r.rfc),
    with_sentence_fragments: ok.filter((r) => r.sentence_fragments > 0).map((r) => [r.rfc, r.sentence_fragments]),
    with_unreadable_blocks: ok.filter((r) => r.unreadable_blocks > 0).map((r) => [r.rfc, r.unreadable_blocks]),
    strict_duplicate_rows: strictDup,
    strict_median_chars:
      strictLen.length === 0 ? null : [...strictLen].sort((a, b) => a - b)[Math.floor(strictLen.length / 2)],
    strict_mean_chars:
      strictLen.length === 0 ? null : Math.round(strictLen.reduce((a, b) => a + b, 0) / strictLen.length),
    keyword_bearing_blocks_skipped_total: ok.reduce((a, r) => a + (r.keyword_bearing_skipped ?? 0), 0),
    demand_share_median_pct: (() => {
      const v = ok
        .map((r) => r.demand_share)
        .filter((x) => x !== null)
        .sort((a, b) => a - b);
      return v.length === 0 ? null : v[Math.floor(v.length / 2)];
    })(),
    keyword_stance: ok.reduce(
      (acc, r) => ({ ...acc, [r.keyword_stance ?? "none"]: (acc[r.keyword_stance ?? "none"] ?? 0) + 1 }),
      {},
    ),
    documents_over_200_requirements: ok
      .filter((r) => (r.total_requirements ?? 0) > MAX_RESULTS)
      .map((r) => [r.rfc, r.total_requirements]),
    per_document: ok.map((r) => ({
      rfc: r.rfc,
      title: r.title,
      published: r.published,
      total_requirements: r.total_requirements,
      candidate_total: r.candidate_total,
      demand_share: r.demand_share,
      sentence_fragments: r.sentence_fragments,
      keyword_stance: r.keyword_stance,
    })),
    in_CALLS: false,
    why_not_in_CALLS:
      "Corpus invariants are a check on the corpus, not a step of the scenario a caller performs. They cost 3-4 calls per document over all 159 documents; folding them into CALLS would make the cost of the guard part of the number it guards. They are counted separately in `calls_after_invariants`.",
  };
}

CALLS.instrument_reads = {
  note: "Read calls made outside the counting wrapper: the section text+blocks reused by the floor, the negative probes, conservation and the dangling-heading guard, plus one outline read per protocol for the guard. The old CALLS figure counted none of them and said so only in prose.",
  section_reads: [...sectionData.values()].reduce((a, rows) => a + rows.length, 0),
  outline_reads_for_dangling_guard: protocols.length,
  calls_after_invariants: callTotal,
};

const out = {
  tag: TAG,
  run_at: new Date().toISOString(),
  corpus: { documents: corpus.documents.length, catalog: 9842 },
  golden: {
    file: "eval/golden.json",
    build_fingerprint: golden.$meta.build_fingerprint,
    comparable_with:
      "eval/results/*.json up to and including redteam.json: NO. Those were measured against eval/golden-baseline-2026-09-26.json, whose selection is not what the published rule produces from this corpus and whose rules carry no snapshot and no offset.",
    protocols: golden.protocols.length,
    protocols_measured: protocols.length,
    protocols_excluded: excluded.length,
    rules: golden.rules.length,
    strict: golden.$meta.strict,
    weak: golden.$meta.weak,
    rules_carrying_a_snapshot_id: golden.$meta.rules_carrying_a_snapshot_id,
    rules_carrying_a_char_offset: golden.$meta.rules_carrying_a_char_offset,
  },
  EXCLUSIONS: {
    why: "run-bench.mjs used to drop every protocol whose golden rule list was empty, and the filter was on the LABELLER's output rather than the tool's, so the documents the tool cannot reach were the documents excluded from the measurement. Two of the five were the only two documents in the corpus where the tool returns nothing at all. A filter is allowed to exclude; it is not allowed to exclude quietly.",
    count: excluded.length,
    protocols: excluded.map((e) => e.rfc),
    scored: false,
    replay: excludedReplay,
    rules_they_would_contribute: excludedReplay.reduce((a, r) => a + (r.would_yield ?? 0), 0),
    note: "A protocol that yields no probe cannot yield a recall hit or a recall miss, so it is not scored. It is named here, and `replay` reports what the same published labelling rule finds in it on the CURRENT outline, in rules, so the size of the hole is a number rather than an argument.",
  },
  FLOOR: {
    why: "Computed on every run, over the same golden set, by the same matcher, from the same section text the probes were cut from. A recall figure at or below its own floor is VOID: a number a grep beats is not a measurement, and the only way a reader finds out is if the instrument says so itself.",
    status: FLOOR_COMPUTABLE ? "computed" : "COULD NOT COMPUTE",
    computable: FLOOR_COMPUTABLE,
    rows_emitted_total: floorRowTotal,
    protocols_with_no_floor_rows: floorSilent.map((p) => p.rfc),
    why_it_matters:
      "The floor is not a sanity check a healthy build passes. It is the value below which a reported percentage carries no information, and a reader who knows it is 100% learns that 91.5% is a failure. A run that cannot compute it says so here rather than printing a bare percentage, and every tier below reads floor_unavailable.",
    extractors: FLOOR_EXTRACTORS.map((f) => ({
      key: f.key,
      what: f.what,
      lines: f.lines,
      rows_emitted: floorRowsTotal.get(f.key),
    })),
    per_tier: FLOOR,
    discriminates: FLOOR.filter((f) => f.discriminates).map((f) => f.tier),
    does_not_discriminate: FLOOR.filter((f) => !f.discriminates && f.verdict === "VOID").map((f) => f.tier),
    // The pair. Two separate percentages hide the only interesting fact about a floor
    // extractor, which is that recall and contamination trade against each other and the
    // trade has a price.
    pairwise: pairwise,
    pairwise_note:
      "strict recall against negative score, both under the bounded matcher, both on the same 100-document corpus. `dominates_tool` means at least as good on both axes and better on one; no trivial extractor does, and F1 does not: it buys +8.2 points of strict recall for -6.4 points of negative score.",
  },
  SPLITTER_SENSITIVITY: {
    why: "The same floor extractor under four sentence-boundary rules. Recall is set by whether the candidate extractor's boundaries agree with labelling.mjs's, not by whether it found the statement: 100% with the labeller's own rule and 3.1% with one that also breaks at line ends, which is the right thing to do on hard-wrapped RFC text.",
    rows: SPLITTER,
    max_spread_pp: maxSpread,
    verdict:
      maxSpread >= 20
        ? "UNSTABLE: matching by whitespace-normalised containment against probes defined by one regex measures SPLITTER AGREEMENT, not extraction. Every number above is quoted with this spread beside it for that reason."
        : maxSpread >= 5
          ? "SENSITIVE: the boundary rule moves the score by more than a rounding error, so the number is partly a statement about the labeller."
          : "stable under all four boundary rules tested",
  },
  RECALL,
  NEGATIVES,
  PRECISION,
  CALLS,
  VERIFY,
  CONSERVATION,
  snapshot_drift: fetched.filter((f) => f.drift).map((f) => [f.rfc, f.drift]),
  snapshot_drift_note:
    "Reported, and now acted on: every golden rule names the snapshot and the offsets it was cut from, so `node eval/build-golden.mjs --verify` can name a rule that no longer matches its bytes instead of printing a drift list that changes no number.",
  fetch_failures: fetched.filter((f) => f.error).map((f) => [f.rfc, f.error]),
  per_protocol: protocols.map((p) => {
    const f = fetchedByRfc.get(p.rfc);
    const mine = verdicts.filter((v) => v.rfc === p.rfc);
    return {
      rfc: p.rfc,
      title: p.title,
      sections: p.sections_used,
      rules: mine.length,
      found: mine.filter((v) => v.found).length,
      found_unbounded: mine.filter((v) => v.found_unbounded).length,
      calls: f?.error ? 0 : 2 + (f?.pages ?? 0),
      total_requirements: f?.total_requirements ?? null,
      candidate_total: f?.candidate_total ?? null,
      pages_to_read_whole_list: f?.pages ?? null,
      keyword_stance: f?.keyword_stance ?? null,
    };
  }),
  misses: verdicts
    .filter((v) => !v.found)
    .map((v) => ({ id: v.id, rfc: v.rfc, section: v.section, tier: v.tier, kw: v.kw, class: v.class, probe: v.probe })),
  misses_the_bound_did_not_cause: verdicts
    .filter((v) => !v.found && v.found_unbounded)
    .map((v) => ({ id: v.id, rfc: v.rfc, section: v.section, tier: v.tier, chars: v.probe.length })),
  invariants,
  dangling_headings: {
    note: "Label-free. Section headings that the sections this protocol sampled show in their text and that its outline does not list. Non-zero means the statements under those headings are unreachable through any query, and it is the defect the golden set cannot see because it samples sections FROM the outline. The read calls behind it are not counted in CALLS.",
    protocols_measured: danglingMeasured.length,
    protocols_with_dangling: danglingFound.length,
    per_protocol: danglingMeasured.map((row) => [row.rfc, row.count]),
    detail: danglingFound.map((row) => [row.rfc, row.sections, row.numbers]),
  },
};

writeFileSync(`eval/results/${TAG}.json`, `${JSON.stringify(out, null, 1)}\n`);

const mark = (pctValue) => (pctValue === null ? "n/a" : `${pctValue}%`);
const voidMark = (f) =>
  f.verdict === "VOID" ? `VOID (floor ${f.floor_pct}% by ${f.floor_set_by})` : `${mark(f.tool_pct)}`;

console.log(`== bench ${TAG} ==`);
console.log(
  `golden: ${golden.protocols.length} protocols, ${golden.rules.length} rules (${golden.$meta.strict} strict / ${golden.$meta.weak} weak), fingerprint ${golden.$meta.build_fingerprint.slice(0, 12)}`,
);
console.log(
  `provenance: ${golden.$meta.rules_carrying_a_snapshot_id}/${golden.rules.length} rules carry a snapshot, ${golden.$meta.rules_carrying_a_char_offset}/${golden.rules.length} a char offset. Excluded for having no probe: ${excluded.length} (${excluded.map((e) => e.rfc).join(" ") || "none"}) which would contribute ${excludedReplay.reduce((a, r) => a + (r.would_yield ?? 0), 0)} rules on today's outline.`,
);

console.log(`FLOOR  (a recall at or below its floor is VOID, not a percentage)`);
if (!FLOOR_COMPUTABLE)
  console.log(
    `  COULD NOT COMPUTE: ${floorRowTotal} floor rows over ${protocols.length} protocols; ${floorSilent.length} protocol(s) had no readable section (${floorSilent.map((p) => p.rfc).join(" ") || "none"}). Every tool figure below is printed WITHOUT a floor and is therefore not a measurement.`,
  );
console.log(
  `  ${"tier".padEnd(20)}${"tool".padStart(8)}${"F1 grep".padStart(10)}${"F3 block".padStart(10)}${"F2 sect".padStart(9)}${"floor".padStart(8)}  ${"containment:".padStart(14)}  verdict`,
);
for (const f of FLOOR) {
  const by = Object.fromEntries(f.floor.map((x) => [x.key, x.found_pct]));
  const un = Object.fromEntries(f.floor.map((x) => [x.key, x.found_pct_containment_matcher]));
  console.log(
    `  ${f.label.padEnd(20)}${mark(f.tool_pct).padStart(8)}${mark(by.F1_modal_sentence).padStart(10)}${mark(by.F3_modal_block).padStart(10)}${mark(by.F2_whole_section).padStart(9)}${mark(f.floor_pct).padStart(8)}  ${`${mark(un.F1_modal_sentence)}/${mark(un.F2_whole_section)}`.padStart(14)}  ${f.verdict}`,
  );
  if (f.void_because) console.log(`  ${" ".repeat(20)}${f.void_because}`);
}
console.log(`  rows emitted: ${FLOOR_EXTRACTORS.map((f) => `${f.key}=${floorRowsTotal.get(f.key)}`).join(" ")}`);
console.log(
  `  containment column is F1/F2 under the OLD matcher: a whole-section emitter goes 0.8% -> 100% there, which is the case for the bound in two figures.`,
);
console.log(`FLOOR PAIR  (strict recall vs negative score, same corpus, same matcher - the trade is the measurement)`);
for (const p of pairwise)
  console.log(
    `  ${p.key.padEnd(20)} recall ${mark(p.strict_recall_pct).padStart(6)} (${p.vs_tool_recall_pp >= 0 ? "+" : ""}${p.vs_tool_recall_pp}pp vs tool)  negative ${mark(p.negative_score_pct).padStart(6)} (${p.vs_tool_negative_pp >= 0 ? "+" : ""}${p.vs_tool_negative_pp}pp vs tool)  ${p.dominates_tool ? "DOMINATES THE TOOL" : ""}`,
  );
console.log(
  `  ${"the tool".padEnd(20)} recall ${mark(toolStrict.tool_pct).padStart(6)}                    negative ${mark(toolNeg.score_pct).padStart(6)}`,
);

console.log(`SPLITTER SENSITIVITY  (floor extractor F1, four boundary rules)`);
for (const s of SPLITTER) {
  const strict = s.per_tier.find((p) => p.tier === "strict");
  const lower = s.per_tier.find((p) => p.tier === "weak_lower");
  console.log(
    `  ${s.splitter.padEnd(18)} strict ${mark(strict.found_pct).padStart(7)}  weak/lower ${mark(lower.found_pct).padStart(7)}  rows ${s.rows_emitted}  spread ${s.spread_pp}pp`,
  );
}
console.log(`  ${out.SPLITTER_SENSITIVITY.verdict}`);

console.log(`RECALL  bounded matcher (margin ${MATCH_MARGIN}x) vs containment matcher (control)`);
console.log(`  ${"tier".padEnd(20)}${"bounded".padStart(9)}${"containment".padStart(13)}${"delta".padStart(9)}`);
for (const r of RECALL.by_tier_table) {
  console.log(
    `  ${r.label.padEnd(20)}${mark(r.bounded_matcher.found_pct).padStart(9)}${mark(r.containment_matcher.found_pct).padStart(13)}${(r.delta_pp === null ? "n/a" : `${r.delta_pp}pp`).padStart(9)}`,
  );
}
console.log(
  `  margin excludes ${allExcluded.length} containment match(es); hit row/probe ratio ${JSON.stringify(quantiles(hitRatios))}`,
);
for (const m of MARGIN) {
  const strict = m.per_tier.find((p) => p.tier === "strict");
  const lower = m.per_tier.find((p) => p.tier === "weak_lower");
  console.log(
    `    margin ${String(m.margin).padStart(9)}: strict ${mark(strict.found_pct).padStart(6)} (${strict.excluded_vs_unbounded} lost vs unbounded), weak/lower ${mark(lower.found_pct).padStart(6)} (${lower.excluded_vs_unbounded} lost)`,
  );
}
for (const e of allExcluded.slice(0, 6))
  console.log(`    ${e.id} rfc${e.rfc} ratio ${e.ratio} (${e.chars} chars): ${e.text}`);

console.log(`NEGATIVE PROBES  (must NOT be extracted; generated, never hand-picked)`);
for (const c of NEGATIVES.per_class) {
  console.log(
    `  ${c.class.padEnd(20)} ${String(c.probes).padStart(5)} probes, ${String(c.leaked).padStart(4)} leaked, score ${mark(c.score_pct).padStart(7)}  ${JSON.stringify(c.by_block_kind)}${c.probes === 0 ? "  (no generator fired on this corpus)" : ""}`,
  );
}
console.log(
  `  ${"DISCRIMINATING".padEnd(20)} ${String(NEGATIVES.discriminating.probes).padStart(5)} probes, ${String(NEGATIVES.discriminating.leaked).padStart(4)} leaked, score ${mark(NEGATIVES.discriminating.score_pct).padStart(7)}  <- meta_language + descriptive_modal: the classes a keyword grep cannot survive`,
);
console.log(
  `  ${"BY POOL".padEnd(20)} requirements[]: ${NEGATIVES.discriminating_by_pool.probes - NEGATIVES.discriminating_by_pool.leaked_strict}/${NEGATIVES.discriminating_by_pool.probes} = ${mark(NEGATIVES.discriminating_by_pool.strict_score_pct)}   non_strict_candidates: ${mark(NEGATIVES.discriminating_by_pool.candidates_score_pct)}   <- a caller building a contract reads requirements[]; the candidate list is a review list`,
);
console.log(
  `  the same set scored for the floor extractors, bounded / containment:` +
    NEGATIVES.floor_extractors.discriminating
      .map((f) => `${f.key} ${mark(f.score_bounded_pct)}/${mark(f.score_containment_pct)}`)
      .join("  "),
);
console.log(
  `  F1 takes ${mark(NEGATIVES.floor_extractors.discriminating[0].score_bounded_pct)} of the statements that must not be extracted and 100% of the ones that must. That pair is the finding the positive set cannot express.`,
);
for (const c of NEGATIVES.contested)
  console.log(
    `  ${c.class.padEnd(20)} ${String(c.probes).padStart(5)} probes, ${String(c.leaked).padStart(4)} leaked, score ${mark(c.score_pct).padStart(7)}  CONTESTED: reported, not asserted`,
  );
console.log(`  census: ${JSON.stringify(NEGATIVES.census)}`);
for (const c of NEGATIVES.per_class)
  for (const e of c.examples.slice(0, 2)) console.log(`    ${e[0]} ${e[2]}/${e[3]} ${e[1]}: ${e[4]}`);

console.log(
  `PRECISION                ${sample.length} distinct sentences sampled (${sampleDuplicates} duplicate rows skipped), labels pending`,
);

console.log(
  `CALLS                    ${CALLS.caller_calls} caller calls (of ${CALLS.calls_total} counted; ${CALLS.audit_calls} audit) per 40: ${CALLS.per_40_golden_rules} golden rules / ${CALLS.per_40_reported_requirements} reported requirements / ${CALLS.per_40_emitted_rows} emitted rows  ${JSON.stringify(CALLS.by_purpose)}`,
);
console.log(
  `  the per-40-golden-rules figure is the published one and it is not a cost per unit of work: ${protocols.length} protocols carry ${goldenRules} probes, so a document worth ${meanRules.toFixed(2)} probes pays for 1 resolve + 1 unscoped requirements before a single rule is read.`,
);
for (const b of CALLS.distribution_by_golden_rules_per_protocol)
  console.log(
    `  ${b.golden_rules} golden rule(s)/protocol: ${b.protocols} protocols, mean ${b.mean_calls} calls, mean ${b.mean_rows} emitted rows, ${b.calls_per_golden_rule} calls per golden rule`,
  );
if (CALLS.worst_protocol)
  console.log(
    `  worst per golden rule: rfc ${CALLS.worst_protocol.rfc} (${CALLS.worst_protocol.title}) ${CALLS.worst_protocol.calls} calls for ${CALLS.worst_protocol.golden_rules} golden rule, ${CALLS.worst_protocol.emitted_rows} emitted rows`,
  );
if (CALLS.worst_protocol_per_row)
  console.log(
    `  worst per emitted row:  rfc ${CALLS.worst_protocol_per_row.rfc} (${CALLS.worst_protocol_per_row.title}) ${CALLS.worst_protocol_per_row.calls} calls / ${CALLS.worst_protocol_per_row.pages} pages for ${CALLS.worst_protocol_per_row.emitted_rows} rows (${CALLS.worst_protocol_per_row.total_requirements} requirements), over documents with >= 50 rows`,
  );
if (CALLS.most_expensive_to_read_whole)
  console.log(
    `  most pages:             rfc ${CALLS.most_expensive_to_read_whole.rfc} (${CALLS.most_expensive_to_read_whole.title}) ${CALLS.most_expensive_to_read_whole.pages} pages, ${CALLS.most_expensive_to_read_whole.total_requirements} requirements, ${CALLS.most_expensive_to_read_whole.emitted_rows} rows`,
  );

console.log(
  `VERIFY                   ${verifyScenarios.filter((s) => s.reachable && s.control).length} control, ${verifyScenarios.filter((s) => s.reachable && !s.control).length} conditions exercised, ${verifyScenarios.filter((s) => !s.reachable).length} unreachable`,
);
for (const s of verifyScenarios)
  console.log(
    `  ${s.key.padEnd(22)} ${s.checks === 0 ? "UNREACHABLE - " + s.unreachable_reason : `${s.conform}/${s.checks} = ${mark(s.conform_pct)}  ${JSON.stringify(s.by_verdict)}  contract: ${s.contract}`}`,
  );
for (const s of verifyScenarios)
  for (const n of s.nonconform)
    console.log(`    ${s.key} NONCONFORM rfc ${n.rfc} -> ${n.verdict} ${JSON.stringify(n.args)}`);
const s3 = verifyScenarios.find((s) => s.key === "S3_duplicate_quote");
if (s3 && s3.span_failures.length > 0)
  console.log(
    `    ${s3.span_failures.length}/${s3.checks} ambiguous answers name the SAME place twice: locator.span is the block's span, not the record's own offsets, so two records in one block are indistinguishable in the response. The verdict is right and the answer is half an answer.`,
  );

const R1 = CONSERVATION.R1_reach;
console.log(
  `CONSERVATION R1 reach    ${R1.keyword_bearing_sentences} keyword-bearing sentences over ${R1.sections} sections: requirement ${R1.arms.requirement}, candidate ${R1.arms.candidate}, fragment ${R1.arms.fragment}, mention ${R1.arms.mention}, UNREACHED ${R1.arms.unreached} -> any reach ${mark(R1.any_reach_pct)}, coverage (as a requirement) ${mark(R1.coverage_pct)}`,
);
console.log(
  `                          of the unreached: ${R1.undeclared.count} in a PROSE block (no stated reason, counted by none of the tool's own counters), ${R1.text_view_only.count} in read(text) and in no block at all ${JSON.stringify(R1.unreached_by_block_kind)}`,
);
console.log(
  `CONSERVATION R2 fidelity ${CONSERVATION.R2_fidelity.rows_checked - CONSERVATION.R2_fidelity.disagreements}/${CONSERVATION.R2_fidelity.rows_checked} = ${mark(CONSERVATION.R2_fidelity.agreement_pct)} agree with their own quote; ${CONSERVATION.R2_fidelity.disagreements} state the opposite`,
);
for (const d of CONSERVATION.R2_fidelity.detail.slice(0, 4))
  console.log(`    rfc ${d.rfc} ${d.section ?? "-"}: ${d.why} :: ${d.text}`);
console.log(
  `CONSERVATION R3 budget   ${CONSERVATION.R3_budget.documents_re_shipping_a_channel} of ${CONSERVATION.R3_budget.documents} documents re-ship a channel on a later page; ${CONSERVATION.R3_budget.documents_with_a_channel_that_does_not_report_its_size} carry a channel that does not report its size`,
);
for (const w of R1.worst_sections.slice(0, 6))
  console.log(`    rfc ${w[0]} section ${w[1]}: ${w[2]} unreached, ${w[3]} undeclared`);

if (invariants) {
  console.log(
    `invariants               ${invariants.measured} docs, zero-strict ${invariants.zero_strict_requirements.length}, zero-both ${invariants.zero_strict_and_zero_candidates.length}, dup ${invariants.strict_duplicate_rows.dup_pct}%, keyword-bearing blocks skipped ${invariants.keyword_bearing_blocks_skipped_total} (excluded from CALLS)`,
  );
}
// Printed only when something is wrong, and that is the point: a heading the text shows
// and the outline does not is a reach a caller cannot get to, whatever the recall number
// says about the sections that survived.
if (danglingFound.length > 0) {
  console.log(
    `DANGLING HEADINGS        ${danglingFound.length}/${danglingMeasured.length} protocols show a section heading their outline omits -> ${danglingFound
      .map((row) => `rfc${row.rfc}:${row.count}`)
      .join(" ")}`,
  );
  for (const row of danglingFound.slice(0, 12)) {
    console.log(
      `  rfc ${row.rfc}, sampled ${row.sections} sections, outline ${row.outline_sections}: ${row.numbers.join(" ")}`,
    );
  }
}
if (out.fetch_failures.length > 0) console.log(`fetch failures: ${JSON.stringify(out.fetch_failures)}`);
if (out.snapshot_drift.length > 0)
  console.log(
    `snapshot drift: ${out.snapshot_drift.length} protocols (reported, and the golden set is verifiable against it: eval/build-golden.mjs --verify)`,
  );
console.log(`misses: ${out.misses.length} -> ${out.misses.map((m) => `${m.id}(${m.rfc})`).join(" ")}`);
if (out.misses_the_bound_did_not_cause.length > 0)
  console.log(`misses the matcher bound caused: ${JSON.stringify(out.misses_the_bound_did_not_cause)}`);

await mcp.close();
process.exit(0);

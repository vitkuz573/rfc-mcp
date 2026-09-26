// Measures recall over eval/golden-ext.json - the documents the main bench could not
// sample. Deliberately separate from eval/run-bench.mjs: the main harness computes the
// four numbers and must not grow a second, differently-shaped path into them.
//
//   node eval/run-bench-ext.mjs
//
// Reports RECALL only. There is no before, and precision is not measured here: these
// documents were unreachable, so nothing about their emitted rows has been reviewed, and
// a precision number over rows nobody has looked at is decoration. What this answers is
// the question the parser fix was made to answer - does a document the parser could not
// reach yield normative statements once it can - and for that, recall against a probe
// cut from its own text is the whole instrument.
//
// Tier separation is the same as the main bench and enforced in one place: a strict probe
// is matched ONLY against requirements[].exact_text and a weak probe ONLY against
// non_strict_candidates.candidates[].exact_text. Matching is whitespace-normalised
// containment on both sides, because RFC text is hard-wrapped and exact_text keeps the
// line breaks.

import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";
import { norm } from "./lib/labelling.mjs";

const MAX_RESULTS = 200;
const MAX_CANDIDATES = 2000;

const golden = JSON.parse(readFileSync("eval/golden-ext.json", "utf8"));
const pct = (n, d) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);

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
let calls = 0;

const byProtocol = new Map();
for (const p of golden.protocols) byProtocol.set(p.rfc, p);
const protocols = golden.protocols.filter((p) => p.rules > 0);

const fetched = await mapLimit(protocols, 4, async (p) => {
  const resolved = await mcp.call("resolve", { rfc: p.rfc });
  calls += 1;
  const snapshot_id = resolved.data?.snapshot?.id ?? null;
  if (!snapshot_id) return { rfc: p.rfc, error: "no snapshot" };
  const strict = [];
  const candidates = [];
  let cursor = null;
  for (let page = 0; page < 60; page += 1) {
    const args = { snapshot_id, max_results: MAX_RESULTS, max_candidates: MAX_CANDIDATES };
    if (cursor) args.cursor = cursor;
    const res = await mcp.call("requirements", args);
    calls += 1;
    if (res.__error) return { rfc: p.rfc, error: res.__error.slice(0, 160) };
    strict.push(...(res.data?.requirements ?? []));
    candidates.push(...(res.data?.non_strict_candidates?.candidates ?? []));
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
  }
  return { rfc: p.rfc, snapshot_id, strict, candidates, total: strict.length };
});

const fetchedByRfc = new Map(fetched.map((f) => [f.rfc, f]));
const verdicts = [];
for (const rule of golden.rules) {
  const f = fetchedByRfc.get(rule.rfc);
  if (!f || f.error) {
    verdicts.push({ ...rule, found: false, verdict: "fetch_failed" });
    continue;
  }
  const pool = rule.tier === "strict" ? f.strict : f.candidates;
  const p = norm(rule.probe);
  const hits = pool.filter((it) => norm(it.exact_text).includes(p));
  verdicts.push({ ...rule, found: hits.length > 0, matched: hits.length, verdict: hits.length > 0 ? "found" : "missed" });
}

const measure = (tier) => {
  const set = verdicts.filter((v) => v.tier === tier);
  const found = set.filter((v) => v.found);
  return { rules: set.length, found: found.length, pct: pct(found.length, set.length) };
};

const out = {
  run_at: new Date().toISOString(),
  source: "eval/golden-ext.json",
  comparable_with_main_bench: false,
  protocols: protocols.length,
  RECALL: {
    strict: measure("strict"),
    weak: measure("weak"),
    weak_lowercase_modal: {
      rules: verdicts.filter((v) => v.class === "lowercase-modal").length,
      found: verdicts.filter((v) => v.class === "lowercase-modal" && v.found).length,
      pct: pct(
        verdicts.filter((v) => v.class === "lowercase-modal" && v.found).length,
        verdicts.filter((v) => v.class === "lowercase-modal").length,
      ),
    },
    keyword_free: {
      rules: verdicts.filter((v) => v.class === "keyword-free-spec").length,
      found: verdicts.filter((v) => v.class === "keyword-free-spec" && v.found).length,
      pct: pct(
        verdicts.filter((v) => v.class === "keyword-free-spec" && v.found).length,
        verdicts.filter((v) => v.class === "keyword-free-spec").length,
      ),
    },
  },
  calls,
  previously_unsampleable: protocols.filter((p) => p.was_unsampleable).map((p) => ({
    rfc: p.rfc,
    title: p.title,
    addressable_sections: p.eligible_sections,
    rules: p.rules,
    found: verdicts.filter((v) => v.rfc === p.rfc && v.found).length,
    total: verdicts.filter((v) => v.rfc === p.rfc).length,
  })),
  misses: verdicts.filter((v) => !v.found).map((v) => ({ id: v.id, rfc: v.rfc, section: v.section, class: v.class, probe: v.probe })),
};

writeFileSync("eval/results/golden-ext-recall.json", `${JSON.stringify(out, null, 1)}\n`);
console.log(`supplementary bench: ${out.protocols} protocols, ${golden.rules.length} rules, ${calls} calls`);
for (const [k, v] of Object.entries(out.RECALL)) {
  console.log(`  RECALL ${k.padEnd(22)} ${v.found}/${v.rules} = ${v.pct}%`);
}
console.log("previously unsampleable protocols:");
for (const row of out.previously_unsampleable) {
  console.log(`  rfc${row.rfc} ${row.addressable_sections} addressable sections -> ${row.found}/${row.total} rules found`);
}
console.log(`misses: ${out.misses.length}`);
await mcp.close();
process.exit(0);

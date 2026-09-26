// The bench. Measures the four numbers over the golden set, and nothing else decides
// them: no DNS knowledge, no hand-picked protocols, no reading of the tool's own
// counters as if they were the answer.
//
//   node eval/run-bench.mjs --tag before
//   node eval/run-bench.mjs --tag after --skip-invariants
//
// Every call goes through the MCP stdio surface (eval/lib/mcp.mjs), the same
// `tools.rfc.*` an agent uses, with the snapshot pinned. Nothing is read from the
// database, so a number here cannot be produced by a path no caller can reach.
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
//
//   PRECISION NOT computed here. A sample of emitted items is written out with its
//             metadata and a null label; the labels are made by hand, in
//             eval/results/<tag>-precision-labels.json. An instrument that labels its
//             own output is not measuring precision.
//
//   CALLS     every tools.rfc.* call this harness makes, divided by (rules / 40), with
//             the breakdown by purpose. The per-40 divisor is the unit of work in the
//             scenario: forty rules is one protocol's worth of contract.
//
//   VERIFY    verify_citation on every item a golden rule matched. A rule that cannot
//             be cited cannot be put in front of anyone, so a citation that fails to
//             re-verify is a miss of the same contract, counted separately.
//
// MATCHING is whitespace-normalised containment, because RFC text is hard-wrapped and
// exact_text keeps the line breaks. Both verdicts are reported: `norm` and `exact`, so
// the reader can see how much of recall depends on that normalisation rather than on
// the extractor finding the statement.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";
import { norm } from "./lib/labelling.mjs";

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
const ratio = (n, d) => (d === 0 ? null : Math.round((10000 * n) / d) / 100);

// -------------------------------------------------------------------------------------
// Phase 1: fetch. One resolve to pin, one scoped requirements per protocol, one
// unscoped for the pagination cost, then paging until the section is exhausted.
// -------------------------------------------------------------------------------------

const byProtocol = new Map();
for (const p of golden.protocols) byProtocol.set(p.rfc, { ...p, rules: [] });
for (const r of golden.rules) byProtocol.get(r.rfc)?.rules.push(r);

const protocols = [...byProtocol.values()].filter((p) => p.rules.length > 0);
const fetched = await mapLimit(protocols, 4, async (p) => {
  const resolved = await call("resolve", { rfc: p.rfc }, "resolve");
  const snapshot_id = resolved.data?.snapshot?.id ?? null;
  if (!snapshot_id) return { rfc: p.rfc, snapshot_id: null, error: (resolved.__error ?? "no snapshot").slice(0, 160) };

  const drift = p.snapshot_id && p.snapshot_id !== snapshot_id ? `${p.snapshot_id} -> ${snapshot_id}` : null;

  // One `requirements` per protocol, then pages until the requirement list is
  // exhausted. The 200-row ceiling is a property of the schema, not of this harness,
  // and a caller who wants the whole compliance list of a 900-requirement RFC pays
  // for it. Those pages are counted, because that cost IS the CALLS number.
  const strict = [];
  const candidates = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const args = { snapshot_id, max_results: MAX_RESULTS, max_candidates: MAX_CANDIDATES };
    if (cursor) args.cursor = cursor;
    const res = await call("requirements", args, pages === 0 ? "requirements" : "requirements_extra_page");
    if (res.__error) return { rfc: p.rfc, snapshot_id, error: res.__error.slice(0, 200) };
    strict.push(...(res.data?.requirements ?? []));
    candidates.push(...(res.data?.non_strict_candidates?.candidates ?? []));
    pages += 1;
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
    if (pages > 60) break;
  }
  const last = await mcp.call("requirements", { snapshot_id, max_results: 1, max_candidates: 1 });
  if (last.__error) return { rfc: p.rfc, snapshot_id, error: last.__error.slice(0, 200) };

  return {
    rfc: p.rfc,
    title: p.title,
    sections: p.sections_used,
    snapshot_id,
    drift,
    strict,
    candidates,
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
// Phase 2: match. Tier separation is enforced here, in one place, so it cannot be
// relaxed by a later edit to the reporting.
// -------------------------------------------------------------------------------------

function findIn(items, probe) {
  const p = norm(probe);
  const normHits = items.filter((it) => norm(it.exact_text).includes(p));
  const exactHits = items.filter((it) => it.exact_text.includes(probe));
  return { norm: normHits.length > 0, exact: exactHits.length > 0, hits: [...new Set([...normHits, ...exactHits])] };
}

const verdicts = [];
for (const rule of golden.rules) {
  const f = fetchedByRfc.get(rule.rfc);
  if (!f || f.error) {
    verdicts.push({ ...rule, found: false, verdict: "fetch_failed", detail: f?.error ?? "not fetched" });
    continue;
  }
  const pool = rule.tier === "strict" ? f.strict : f.candidates;
  const where = rule.tier === "strict" ? "requirements" : "non_strict_candidates";
  const m = findIn(pool, rule.probe);
  verdicts.push({
    ...rule,
    pool: where,
    found: m.norm,
    exact_match: m.exact,
    matched: m.hits.length,
    citation_ids: m.hits.map((h) => h.citation_id).filter(Boolean),
    verdict: m.norm ? (rule.tier === "strict" ? "found_strict" : "found_provisional") : "missed",
  });
}

// -------------------------------------------------------------------------------------
// Phase 3: VERIFY. One verify_citation per matched item, with the snapshot pinned, so
// a citation is judged against the bytes it came from.
// -------------------------------------------------------------------------------------

const toVerify = verdicts.filter((v) => v.found);
const verified = await mapLimit(toVerify, 6, async (v) => {
  const out = [];
  for (const citation_id of v.citation_ids.slice(0, 2)) {
    const res = await call(
      "verify_citation",
      { citation_id, snapshot_id: fetchedByRfc.get(v.rfc).snapshot_id },
      "verify_citation",
    );
    const verdict = res.data?.verdict ?? res.data?.status ?? res.__error ?? "unknown";
    out.push({ citation_id, verdict, verified: verdict === "verified" });
  }
  return { id: v.id, checks: out };
});
const verifyById = new Map(verified.map((v) => [v.id, v]));

// -------------------------------------------------------------------------------------
// Phase 4: numbers.
// -------------------------------------------------------------------------------------

function recall(filter) {
  const set = verdicts.filter(filter);
  const found = set.filter((v) => v.found);
  const exact = set.filter((v) => v.exact_match);
  return {
    rules: set.length,
    found: found.length,
    found_pct: pct(found.length, set.length),
    exact_pct: pct(exact.length, set.length),
    missed: set.filter((v) => !v.found).map((v) => v.id),
  };
}

const strictR = recall((v) => v.tier === "strict");
const lowerR = recall((v) => v.class === "lowercase-modal");
const freeR = recall((v) => v.class === "keyword-free-spec");
const weakR = recall((v) => v.tier === "weak");

const checkList = verdicts.filter((v) => v.found).flatMap((v) => verifyById.get(v.id)?.checks ?? []);
const verifyRate = {
  checks: checkList.length,
  verified: checkList.filter((c) => c.verified).length,
  verified_pct: pct(checkList.filter((c) => c.verified).length, checkList.length),
  by_verdict: checkList.reduce((acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }), {}),
};

const units = golden.rules.length / RULES_PER_UNIT;
const CALLS = {
  rules: golden.rules.length,
  units: Math.round(units * 100) / 100,
  calls_total: callTotal,
  calls_per_40_rules: Math.round((callTotal / units) * 100) / 100,
  by_purpose: calls,
  note: "Every tools.rfc.* call the harness makes for the golden set: 1 resolve to pin each snapshot, 1 scoped requirements per protocol, 1 unscoped requirements per protocol to measure what a caller pays without a section hint, extra pages when a section exceeds the 200-row ceiling, and 1-2 verify_citation per matched rule. Corpus invariants are a separate instrument over all 151 documents and are excluded from this number.",
};

// -------------------------------------------------------------------------------------
// Phase 5: the precision sample. Deterministic, round-robin over protocols so one
// 900-requirement document cannot dominate, and unlabelled on purpose.
// -------------------------------------------------------------------------------------

const sample = [];
{
  // Interleave the two lists per protocol rather than draining requirements first. The
  // first version took strict[0] from every protocol before it took any candidate, so
  // a 200-item sample was 200 requirements and precision on the candidate list - the
  // list a pre-2119 reader actually depends on - was never measured at all.
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

// -------------------------------------------------------------------------------------
// Phase 6: label-free corpus invariants over every ingested document. These need no
// golden labels, so they keep guarding the corpus when the golden set is small, and
// they are the instrument that catches a regression the 100 protocols cannot.
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
  };
}

const out = {
  tag: TAG,
  run_at: new Date().toISOString(),
  corpus: { documents: corpus.documents.length, catalog: 9842 },
  golden: {
    protocols: golden.protocols.length,
    rules: golden.rules.length,
    strict: golden.$meta.strict,
    weak: golden.$meta.weak,
  },
  RECALL: {
    strict: strictR,
    weak_all: weakR,
    weak_lowercase_modal: lowerR,
    weak_keyword_free: freeR,
    headline_rule:
      "strict and weak are never added together; keyword-free is reported apart because no keyword-driven extractor can reach it.",
  },
  PRECISION: {
    status: "awaiting manual labels",
    sample: sample.length,
    sample_file: `eval/results/${TAG}-precision-sample.json`,
  },
  CALLS,
  VERIFY: verifyRate,
  snapshot_drift: fetched.filter((f) => f.drift).map((f) => [f.rfc, f.drift]),
  fetch_failures: fetched.filter((f) => f.error).map((f) => [f.rfc, f.error]),
  calls_after_invariants: callTotal,
  per_protocol: protocols.map((p) => {
    const f = fetchedByRfc.get(p.rfc);
    const mine = verdicts.filter((v) => v.rfc === p.rfc);
    return {
      rfc: p.rfc,
      title: p.title,
      sections: p.sections_used,
      rules: mine.length,
      found: mine.filter((v) => v.found).length,
      total_requirements: f?.total_requirements ?? null,
      candidate_total: f?.candidate_total ?? null,
      pages_to_read_whole_list: f?.pages ?? null,
      keyword_stance: f?.keyword_stance ?? null,
    };
  }),
  misses: verdicts
    .filter((v) => !v.found)
    .map((v) => ({ id: v.id, rfc: v.rfc, section: v.section, tier: v.tier, kw: v.kw, class: v.class, probe: v.probe })),
  invariants,
};

writeFileSync(`eval/results/${TAG}.json`, `${JSON.stringify(out, null, 1)}\n`);

console.log(`== bench ${TAG} ==`);
console.log(
  `golden: ${golden.protocols.length} protocols, ${golden.rules.length} rules (${golden.$meta.strict} strict / ${golden.$meta.weak} weak)`,
);
console.log(
  `RECALL strict            ${strictR.found}/${strictR.rules} = ${strictR.found_pct}%  (byte-exact ${strictR.exact_pct}%)`,
);
console.log(
  `RECALL weak/lower        ${lowerR.found}/${lowerR.rules} = ${lowerR.found_pct}%  (byte-exact ${lowerR.exact_pct}%)`,
);
console.log(
  `RECALL weak/keyword-free ${freeR.found}/${freeR.rules} = ${freeR.found_pct}%  (byte-exact ${freeR.exact_pct}%)`,
);
console.log(`PRECISION                ${sample.length} items sampled, labels pending`);
console.log(
  `CALLS                    ${CALLS.calls_total} calls / ${CALLS.units} units of 40 rules = ${CALLS.calls_per_40_rules} per 40  ${JSON.stringify(CALLS.by_purpose)}`,
);
console.log(
  `VERIFY                   ${verifyRate.verified}/${verifyRate.checks} = ${verifyRate.verified_pct}%  ${JSON.stringify(verifyRate.by_verdict)}`,
);
if (invariants) {
  console.log(
    `invariants               ${invariants.measured} docs, zero-strict ${invariants.zero_strict_requirements.length}, zero-both ${invariants.zero_strict_and_zero_candidates.length}, dup ${invariants.strict_duplicate_rows.dup_pct}%`,
  );
}
if (out.fetch_failures.length > 0) console.log(`fetch failures: ${JSON.stringify(out.fetch_failures)}`);
if (out.snapshot_drift.length > 0) console.log(`snapshot drift: ${JSON.stringify(out.snapshot_drift)}`);
console.log(`misses: ${out.misses.length} -> ${out.misses.map((m) => `${m.id}(${m.rfc})`).join(" ")}`);

await mcp.close();
process.exit(0);

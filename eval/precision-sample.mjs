// Draws a precision sample from ONE list only, without recomputing the four numbers.
//
//   node eval/precision-sample.mjs --tag before --kind non_strict_candidate --n 125
//
// The main run's sample interleaves both lists per protocol, which is what a reader
// wants, but it also spends a full bench run to produce it. When a list needs its own
// measurement - as the candidate list does, because it is three times the size of the
// requirement list on a pre-2119 document and a reader depends on it more - this draws
// from that list alone so the labelling is not blocked on a 15-minute run.
//
//   --kind requirement | non_strict_candidate
//   --n      items to draw
//   --tag    label written into sample_id and the output filename

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const TAG = arg("--tag", "run");
const KIND = arg("--kind", "non_strict_candidate");
const N = Number(arg("--n", "125"));
const MAX_RESULTS = 200;
const MAX_CANDIDATES = 2000;

const golden = JSON.parse(readFileSync("eval/golden.json", "utf8"));
mkdirSync("eval/results", { recursive: true });

const { mcp } = await connect();

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

/** Every requirement row of a document, following next_cursor to the end. */
async function readRequirements(mcp, snapshot_id) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 60; page += 1) {
    const args = { snapshot_id, max_results: MAX_RESULTS, max_candidates: 1 };
    if (cursor) args.cursor = cursor;
    const res = await mcp.call("requirements", args);
    if (res.__error) break;
    out.push(...(res.data?.requirements ?? []));
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

const pools = await mapLimit(
  golden.protocols.filter((p) => (p.rules ?? 0) > 0),
  4,
  async (p) => {
    const resolved = await mcp.call("resolve", { rfc: p.rfc });
    const snapshot_id = resolved.data?.snapshot?.id ?? null;
    if (!snapshot_id) return { rfc: p.rfc, items: [] };
    const res = await mcp.call("requirements", { snapshot_id, max_results: 1, max_candidates: MAX_CANDIDATES });
    const candidates = res.data?.non_strict_candidates?.candidates ?? [];
    // The first call asks for one row to learn the document's shape; the requirement list
    // is then read at the page ceiling. Sampling from the one-row response would have
    // measured `max_results: 1` instead of the tool.
    const wanted = KIND === "requirement" ? await readRequirements(mcp, snapshot_id) : candidates;
    // The candidate list is RANKED - shape=demand first, then role=modal, then upper
    // case, then document order. Taking its head samples only the rows the ranker
    // already decided are the most obligation-like, which is the one place a false
    // positive is least likely. Striding the list keeps the shape and case mix the
    // caller actually receives.
    const stride = wanted.length > 24 ? Math.max(1, Math.floor(wanted.length / 12)) : 1;
    const picked = [];
    for (let i = 0; i < wanted.length; i += stride) picked.push(wanted[i]);
    return {
      rfc: p.rfc,
      title: p.title,
      stride,
      items: picked.map((it) => ({
        rfc: p.rfc,
        section: it.section ?? null,
        kind: KIND,
        keyword: it.keyword ?? null,
        keyword_case: it.keyword_case ?? null,
        role: it.role ?? null,
        shape: it.shape ?? null,
        reason: it.reason ?? null,
        text: it.exact_text,
        label: null,
      })),
    };
  },
);

const sample = [];
const seen = new Set();
let duplicates = 0;
let progressed = true;
while (sample.length < N && progressed) {
  progressed = false;
  for (const pool of pools) {
    const item = pool.items.shift();
    if (!item) continue;
    // Dedupe on (rfc, normalised text). The same sentence is emitted up to twelve times in
    // one document and the candidate list is 22.6% duplicates within the 100 measured
    // protocols, so an undeduped draw labels one sentence repeatedly and the effective n
    // is smaller than the printed n - which is a number the reader cannot see. The count of
    // what was skipped is printed, because the row-level and the sentence-level precision
    // figures are different figures.
    const key = `${item.rfc}|${String(item.text ?? "")
      .replace(/\s+/gu, " ")
      .trim()}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    progressed = true;
    sample.push({
      sample_id: `${TAG}-${KIND === "requirement" ? "REQ" : "CAND"}${String(sample.length + 1).padStart(3, "0")}`,
      ...item,
    });
  }
}

const file = `eval/results/${TAG}-precision-${KIND}.json`;
writeFileSync(file, `${JSON.stringify(sample, null, 1)}\n`);
console.log(`${file}: ${sample.length} items from ${pools.filter((p) => p.items.length >= 0).length} protocols`);
console.log(
  `${duplicates} duplicate (rfc, text) rows skipped: the same sentence is emitted up to 12 times in one document, so an undeduped draw has an effective n smaller than its printed n.`,
);
console.log(
  `by shape: ${JSON.stringify(sample.reduce((a, i) => ({ ...a, [i.shape ?? "none"]: (a[i.shape ?? "none"] ?? 0) + 1 }), {}))}`,
);
console.log(
  `by keyword_case: ${JSON.stringify(sample.reduce((a, i) => ({ ...a, [i.keyword_case ?? "none"]: (a[i.keyword_case ?? "none"] ?? 0) + 1 }), {}))}`,
);

await mcp.close();
process.exit(0);

// Applies earlier hand labels to a new sample, and prints only what is left to judge.
//
//   node eval/apply-labels.mjs --sample eval/results/after-precision-non_strict_candidate.json \
//                              --from   eval/results/before-precision-labels-candidates.json
//
// A label is a judgement about a sentence, so the same sentence keeps the same label
// whatever the code did to the list around it. That makes reuse sound and the shortcut
// worth taking: re-judging 190 items from scratch after seeing which ones the change
// moved is how a bench starts agreeing with itself.
//
// What this script will not do is guess. Anything whose (rfc, text) pair is absent from
// an earlier label file is printed for hand labelling, and both counts are reported, so
// a reader can see how much of the new sample was carried over and how much was judged
// fresh. Label files are hand-written; nothing here produces one.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fromFiles = [];
{
  const i = args.indexOf("--from");
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j += 1) fromFiles.push(args[j]);
}

const sampleFile = val("--sample");
if (!sampleFile || fromFiles.length === 0) {
  console.error("usage: node eval/apply-labels.mjs --sample <file> --from <label.json> [...]");
  process.exit(2);
}

const sample = JSON.parse(readFileSync(sampleFile, "utf8"));
const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/gu, " ")
    .trim();

/** "rfc|normalised text" -> { label, reason, source } */
const prior = new Map();

for (const file of fromFiles) {
  const doc = JSON.parse(readFileSync(file, "utf8"));

  // Form A: a flat `labels` array, with the sample it describes named in the file.
  if (Array.isArray(doc.labels) && doc.sample_file) {
    const items = JSON.parse(readFileSync(doc.sample_file, "utf8"));
    const byId = new Map(items.map((x) => [x.sample_id, x]));
    for (const entry of doc.labels) {
      const item = byId.get(entry.sample_id);
      if (!item) continue;
      prior.set(`${item.rfc}|${norm(item.text)}`, {
        label: entry.label === true,
        reason: entry.reason ?? null,
        source: file,
      });
    }
  }

  // Form B: a `false` map keyed by reason, with the sample it describes named in the file.
  if (doc.false && doc.sample_file) {
    const items = JSON.parse(readFileSync(doc.sample_file, "utf8"));
    const byId = new Map(items.map((x) => [x.sample_id, x]));
    for (const [reason, ids] of Object.entries(doc.false)) {
      for (const id of ids) {
        const item = byId.get(id);
        if (!item) continue;
        prior.set(`${item.rfc}|${norm(item.text)}`, { label: false, reason, source: file });
      }
    }
  }
}

const carried = [];
const fresh = [];
for (const item of sample) {
  const hit = prior.get(`${item.rfc}|${norm(item.text)}`);
  if (hit) carried.push({ sample_id: item.sample_id, rfc: item.rfc, ...hit, text: item.text });
  else fresh.push(item);
}

const carriedTp = carried.filter((c) => c.label).length;
console.log(`sample ${sample.length}: carried ${carried.length}, to hand-label ${fresh.length}`);
console.log(
  `carried precision: ${carried.length === 0 ? "n/a" : `${Math.round((1000 * carriedTp) / carried.length) / 10}%`} (${carriedTp}/${carried.length})`,
);
console.log("--- to hand-label ---");
for (const item of fresh) {
  console.log(
    `${item.sample_id} rfc${item.rfc} kw=${item.keyword}/${item.keyword_case} ${item.role}/${item.shape} :: ${norm(item.text).slice(0, 165)}`,
  );
}

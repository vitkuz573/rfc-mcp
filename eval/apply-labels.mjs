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
// What this script will not do is guess. Anything whose carry key is absent from an
// earlier label file is printed for hand labelling, and both counts are reported, so a
// reader can see how much of the new sample was carried over and how much was judged
// fresh. Label files are hand-written; nothing here produces one.
//
// THE CARRY KEY IS (rfc, kind, text), NOT (rfc, text). The two lists are judged by
// different heads: RFC 8174 gives an uncapitalised keyword no normative force, so a
// sentence labelled TRUE as a `requirement` can be FALSE as a `non_strict_candidate`.
// The old key omitted `kind` and `prior.set` overwrote, so a contradiction between two
// existing label files was stored silently and the script could not see it. It already
// had one: rfc 7872, TRUE in before-precision-labels.json and FALSE in
// before-precision-labels-candidates.json, under the same key. The key is fixed and the
// collisions are now REPORTED rather than resolved, because a label file that disagrees
// with itself is a question for the person who wrote it, not something to average.

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

/** (rfc, kind, normalised text) -> { label, reason, source } */
const prior = new Map();

/** Every place two label files disagreed about the same sentence in the same list. */
const collisions = [];

const keyOf = (rfc, kind, text) => `${rfc}|${kind ?? "untyped"}|${norm(text)}`;

const record = (key, entry) => {
  const seen = prior.get(key);
  if (seen && (seen.label !== entry.label || (seen.reason ?? null) !== (entry.reason ?? null))) {
    collisions.push({ key, first: seen, second: entry });
    return;
  }
  prior.set(key, entry);
};

for (const file of fromFiles) {
  const doc = JSON.parse(readFileSync(file, "utf8"));

  // Form A: a flat `labels` array, with the sample it describes named in the file.
  if (Array.isArray(doc.labels) && doc.sample_file) {
    const items = JSON.parse(readFileSync(doc.sample_file, "utf8"));
    const byId = new Map(items.map((x) => [x.sample_id, x]));
    for (const entry of doc.labels) {
      const item = byId.get(entry.sample_id);
      if (!item) continue;
      record(keyOf(item.rfc, item.kind, item.text), {
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
        record(keyOf(item.rfc, item.kind, item.text), { label: false, reason, source: file });
      }
    }
  }
}

const carried = [];
const fresh = [];
for (const item of sample) {
  const hit = prior.get(keyOf(item.rfc, item.kind, item.text));
  if (hit) carried.push({ sample_id: item.sample_id, rfc: item.rfc, kind: item.kind ?? null, ...hit, text: item.text });
  else fresh.push(item);
}

const carriedTp = carried.filter((c) => c.label).length;
console.log(`sample ${sample.length}: carried ${carried.length}, to hand-label ${fresh.length}`);
console.log(
  `carried precision: ${carried.length === 0 ? "n/a" : `${Math.round((1000 * carriedTp) / carried.length) / 10}%`} (${carriedTp}/${carried.length})`,
);
console.log(`carry key: rfc|kind|normalised text. Prior labels: ${prior.size} keys from ${fromFiles.length} file(s).`);
if (collisions.length > 0) {
  console.log(`CONTRADICTIONS: ${collisions.length} key(s) carry two different verdicts. Not resolved here.`);
  for (const c of collisions)
    console.log(
      `  ${c.key.slice(0, 190)}\n    ${c.first.source}: ${c.first.label ? "TRUE" : "FALSE"}/${c.first.reason ?? "-"}   ${c.second.source}: ${c.second.label ? "TRUE" : "FALSE"}/${c.second.reason ?? "-"}`,
    );
}
console.log("--- to hand-label ---");
for (const item of fresh) {
  console.log(
    `${item.sample_id} rfc${item.rfc} kw=${item.keyword}/${item.keyword_case} ${item.role}/${item.shape} :: ${norm(item.text).slice(0, 165)}`,
  );
}

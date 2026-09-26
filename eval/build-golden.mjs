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
//   node eval/build-golden.mjs --verify   # re-derive and prove the file, byte for byte
//
// EVERY RULE NAMES ITS BYTES. The previous artefact recorded a snapshot id per protocol
// and nothing at all on the 260 rules that are scored: 0/260 carried a snapshot, 0/260
// carried an offset, 95/95 protocols had drifted, and ten probes were not reachable in
// the section they named - RFC 959's G0004 claims a 154-character sentence in section "5",
// which now returns 30 characters. A golden set that cannot name the bytes it was cut
// from cannot be re-verified after a re-sync, and it was not being re-verified: drift was
// printed and no number moved. So each rule now carries `snapshot_id`, `char_start` and
// `char_end` in the raw section text, the same span in the normalised view, the number of
// times the sentence occurs in that section, and a hash of the probe. A rule whose
// section no longer contains it is a named failure, not a silent miss.
//
// REPRODUCIBILITY, precisely. The artefact is a pure function of three inputs: the bytes
// of `eval/corpus.json`, the snapshots those documents resolve to, and the rules in
// `eval/lib/labelling.mjs`. `--verify` rebuilds it in memory and compares the serialised
// bytes with the committed file, then re-locates every rule in the live store. There is
// no wall-clock field, deliberately: a `built_at` date makes byte-for-byte comparison
// impossible and a comparison that is impossible is a check that is not run. What replaces
// it is `build_fingerprint`, a hash over exactly those three inputs, so a change in the
// corpus or in the labelling rules changes the fingerprint and is visible without
// diffing 260 records.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "./lib/mcp.mjs";
import {
  danglingHeadings,
  locate,
  RULES_PER_PROTOCOL,
  rulesFromSection,
  sectionProbeOrder,
  SKIP_KINDS_FOR_PROBE,
} from "./lib/labelling.mjs";

const STRATA = 10;
const PER_STRATUM = 10;
const DRY = process.argv.includes("--dry");
const VERIFY = process.argv.includes("--verify");

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

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
const corpusBytes = readFileSync("eval/corpus.json");
const corpus = JSON.parse(corpusBytes.toString("utf8"));
const labellingSource = readFileSync("eval/lib/labelling.mjs", "utf8");
const picked = pickProtocols(corpus.documents.map((d) => d.rfc));

const protocols = [];
const rules = [];
const diagnostics = [];
const inputs = [];

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
  inputs.push({
    rfc,
    snapshot_id,
    parser: resolved.data.snapshot?.parser_version ?? null,
    extractor: resolved.data.snapshot?.extractor_version ?? null,
  });

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
      collected.push({ ...r, _text: payload.text });
    }
    if (collected.length >= RULES_PER_PROTOCOL) break;
  }

  const shared = {
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
  if (collected.length === 0) {
    note.problems.push(`no eligible sentence in sections ${tried.map((t) => t.section).join(",")}`);
    return shared;
  }
  return { ...shared, collected };
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
    // The offsets are the point of the rebuild. A probe that cannot be located in the text
    // it was cut from is not a rule, it is an accident, and it is recorded as one.
    const at = locate(rule._text, rule.probe);
    const { _text, ...rest } = rule;
    rules.push({
      id,
      rfc: r.rfc,
      snapshot_id: r.snapshot_id,
      ...rest,
      probe_sha256: sha256(rule.probe),
      located: at !== null,
      char_start: at ? at.raw_start : null,
      char_end: at ? at.raw_end : null,
      norm_start: at ? at.norm_start : null,
      norm_end: at ? at.norm_end : null,
      occurrences_in_section: at ? at.occurrences : null,
    });
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

/**
 * A hash over the three things the artefact is a function of. Change any of them and this
 * changes, which is how a future reader learns that the numbers moved for a reason other
 * than the tool.
 */
const buildFingerprint = sha256(
  JSON.stringify({
    corpus: sha256(corpusBytes.toString("utf8")),
    labelling: sha256(labellingSource),
    selection: { STRATA, PER_STRATUM, RULES_PER_PROTOCOL, order: "sectionProbeOrder" },
    snapshots: inputs.map((i) => [i.rfc, i.snapshot_id, i.parser, i.extractor]).sort((a, b) => a[0] - b[0]),
  }),
);

const out = {
  $meta: {
    title: "Golden set: 100 protocols, labelled normative statements, for the RFC -> contract -> code scenario.",
    build_fingerprint: buildFingerprint,
    reproducible_with: "node eval/build-golden.mjs --verify",
    fingerprint_covers: [
      "the bytes of eval/corpus.json",
      "the source of eval/lib/labelling.mjs",
      "the snapshot id, parser version and extractor version of every protocol resolved during the build",
    ],
    protocols: protocols.length,
    rules: rules.length,
    strict: byTier("strict"),
    weak: byTier("weak"),
    rules_carrying_a_snapshot_id: rules.filter((x) => x.snapshot_id).length,
    rules_carrying_a_char_offset: rules.filter((x) => typeof x.char_start === "number").length,
    rules_locatable_in_their_section: rules.filter((x) => x.located).length,
    by_class: {
      "uppercase-modal": byClass("uppercase-modal"),
      "lowercase-modal": byClass("lowercase-modal"),
      "keyword-free-spec": byClass("keyword-free-spec"),
    },
    protocol_selection: `${STRATA} equal strata of the corpus by RFC number, ${PER_STRATUM} evenly spaced per stratum. No document is added, dropped or reordered by hand, so the bench cannot drift toward a family the extractor happens to handle. This is the same rule the previous artefact claimed and did not follow: 33 of its 100 protocols were not what this rule produces from the committed 159-document corpus, because the corpus grew from 151 and the file was never rebuilt.`,
    section_selection:
      "Numbered sections sampled outward from the middle of the document (1/2, 1/4, 3/4, 1/8, 7/8, 3/8, 5/8) until the protocol has three rules or the order runs out. Prose-only kinds are skipped; appendices are not, because appendices hold the field definitions a keyword-driven pass misses. `references` and `authors` ARE skipped: eight bibliography entries and two author addresses were admitted as probes, and the project's own miss review had already classified all eight of the bibliography ones as labelling errors.",
    labelling:
      "A candidate is any sentence carrying a modal token matched case-insensitively (must|shall|should|may|required|recommended|optional). Tier is derived from case alone: an upper-case RFC 2119/8174 keyword makes it strict, anything else weak. Selection never looks at case, and no rule is ever taken from the extractor's output.",
    matching:
      "Whitespace-normalised substring containment, applied to probe and candidate alike, because RFC text is hard-wrapped and exact_text keeps the line breaks. The bench ALSO scores a bounded matcher in which the emitted row may not exceed the probe by more than a stated margin; containment alone lets one row per section score 100%, which is a fact about containment and not about extraction.",
    tier_separation:
      "strict is matched ONLY against requirements[].exact_text and weak ONLY against non_strict_candidates.candidates[].exact_text. A provisional hit never counts as a normative one; mixing the two would inflate recall by construction.",
    supersedes: {
      file: "eval/golden-baseline-2026-09-26.json",
      why: "The previous artefact is a HISTORICAL BASELINE, not a golden set, and its numbers are not comparable to any run made against this file. It is kept, unmodified, because it is the referent of every result in eval/results/ up to and including redteam.json, and deleting the thing a published number was measured against would leave the number with nothing behind it.",
      evidence: [
        "33 of its 100 protocols are not what pickProtocols() produces from the committed 159-document corpus (33 picked but absent, 33 present but not picked)",
        "95 of 95 protocols had drifted between the recorded snapshot and the live one",
        "0 of 260 rules carried a snapshot id; 0 of 260 carried a byte or character offset",
        "10 of its probes are not present in the section they name, so node eval/build-golden.mjs did not and cannot reproduce it",
      ],
    },
  },
  protocols: protocols.sort((a, b) => a.rfc - b.rfc),
  rules,
};

const serialised = `${JSON.stringify(out, null, 1)}\n`;

if (VERIFY) {
  // Two questions, asked separately, because a file can be reproducible in one sense
  // and not the other. `identical` asks whether re-running the published rule over the
  // same store produces the same bytes. `reverified` asks whether every rule still names
  // the bytes it was cut from. A file that passes the first and fails the second is a
  // golden set whose selection is reproducible and whose content has rotted, and that is
  // a different defect with a different fix.
  const onDisk = readFileSync("eval/golden.json", "utf8");
  const identical = onDisk === serialised;
  let firstDiff = null;
  if (!identical) {
    const a = onDisk.split("\n");
    const b = serialised.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        firstDiff = { line: i + 1, on_disk: a[i] ?? null, rebuilt: b[i] ?? null };
        break;
      }
    }
  }

  const stale = [];
  const reverified = await mapLimit(rules, 4, async (rule) => {
    const resolved = await mcp.call("resolve", { rfc: rule.rfc });
    const live = resolved.data?.snapshot?.id ?? null;
    if (live !== rule.snapshot_id)
      stale.push({ id: rule.id, rfc: rule.rfc, why: "snapshot_drift", recorded: rule.snapshot_id, live });
    const res = await mcp.call("read", {
      snapshot_id: live,
      section: rule.section,
      include: ["text"],
      max_output_bytes: 60000,
    });
    const at = locate(res.data?.text ?? "", rule.probe);
    if (!at) {
      stale.push({
        id: rule.id,
        rfc: rule.rfc,
        section: rule.section,
        why: "probe_absent_from_its_section",
        section_chars: (res.data?.text ?? "").length,
        probe_chars: rule.probe.length,
      });
      return null;
    }
    if (at.raw_start !== rule.char_start || at.raw_end !== rule.char_end) {
      stale.push({
        id: rule.id,
        rfc: rule.rfc,
        section: rule.section,
        why: "offset_moved",
        recorded: [rule.char_start, rule.char_end],
        live: [at.raw_start, at.raw_end],
      });
    }
    return { id: rule.id, ok: true };
  });

  const report = {
    checked_at: null,
    fingerprint: buildFingerprint,
    file: "eval/golden.json",
    identical,
    rules: rules.length,
    rules_checked: reverified.length,
    reverified: reverified.length,
    stale: stale.length,
    stale_detail: stale.slice(0, 40),
    first_diff: firstDiff,
    verdict:
      identical && stale.length === 0 ? "reproducible" : identical ? "reproducible_but_stale" : "not_reproducible",
  };
  console.log(JSON.stringify(report, null, 1));
  await mcp.close();
  process.exit(identical && stale.length === 0 ? 0 : 1);
}

if (!DRY) writeFileSync("eval/golden.json", serialised);

console.log(
  `protocols: ${protocols.length}  rules: ${rules.length}  strict: ${out.$meta.strict}  weak: ${out.$meta.weak}`,
);
console.log(JSON.stringify(out.$meta.by_class));
console.log(
  `provenance: ${out.$meta.rules_carrying_a_snapshot_id}/${rules.length} rules carry a snapshot, ${out.$meta.rules_carrying_a_char_offset}/${rules.length} carry a char offset, ${out.$meta.rules_locatable_in_their_section}/${rules.length} locate in the section they name`,
);
console.log(`build_fingerprint: ${buildFingerprint}`);
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

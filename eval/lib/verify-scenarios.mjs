// VERIFY, decomposed into the verdicts that can actually fail.
//
// The bench used to report one number: 99.6% of the citations attached to a matched
// recall rule came back `verified`. That is the store checked against itself. The quote
// and the block come from the same record, so they agree by construction, and 99.6% of it
// is a tautology. Meanwhile `stale`, `ambiguous` and `integrity_failure` - the three
// verdicts that would report a real derivation problem - were never observed, so the
// number was untested against the conditions it exists to catch.
//
// A single pooled percentage is what hid that. Each scenario below is one named
// condition with the verdict the contract says it must produce, checked separately and
// reported separately, with `conform` and the raw verdict census beside it. A scenario
// that cannot be constructed is reported as `unreachable` with the reason, because
// "untested" and "passing" are different answers and only one of them is being claimed.
//
// S1 is the tautology and is kept, labelled as the control. Deleting it would leave the
// other four with nothing to be compared against, and a reader is entitled to know which
// of the five is the one that proves nothing.

import { createHash } from "node:crypto";

/** `quoteHash` in src/analysis/citation.ts: `sha256:` + hex of the exact text. */
export const quoteHash = (quote) => `sha256:${createHash("sha256").update(quote, "utf8").digest("hex")}`;

/**
 * Flip the last hex character of a `cit_`/`scit_` id. One character is enough: the ids
 * are hashes, so a corrupted one cannot collide with a real record, and the point of the
 * check is that a miss is reported as a miss rather than resolved to the nearest thing.
 */
export function corruptId(id) {
  const last = id.slice(-1);
  const next = last === "0" ? "1" : "0";
  return `${id.slice(0, -1)}${next}`;
}

/** The same one-character treatment for a `snp_` pin. */
export function corruptSnapshot(snapshotId) {
  return corruptId(snapshotId);
}

export const VERIFY_SCENARIOS = [
  {
    key: "S1_same_derivation",
    contract: "verified",
    expect: ["verified"],
    forbid: [],
    control: true,
    why: "CONTROL, and the only tautology here: the citation is read off a row of this derivation and verified against the snapshot this derivation was made from. A pass says the store is self-consistent, which is worth knowing and is not evidence about any other derivation.",
  },
  {
    key: "S2_other_derivation",
    contract: "stale or not_found, NEVER verified",
    expect: [],
    forbid: ["verified"],
    why: "The same id against a DIFFERENT document's derivation. A derived id is a function of its snapshot, block and offset, so a record that resolves in a store it was not minted in is a provenance failure and answering `verified` would be the tool claiming a quote it never read.",
  },
  {
    key: "S3_duplicate_quote",
    contract: "ambiguous, with every span named",
    expect: ["ambiguous"],
    forbid: ["verified", "not_found"],
    min_spans: 2,
    why: "A sentence that occurs twice in one document. The id names a sentence, not a place, so the only correct answer reports both places. `not_found` is a failure of the search and `verified` is a guess; both are caught here.",
    span_caveat:
      "`locator.span` on a verify response is the BLOCK's span, not the record's own offsets, so two stored records that live in one block come back with the same locator. `distinct_spans` counts locators that differ, which is the only distinction the response makes. A scenario that returns `ambiguous` twice with the same place has answered half the question, and `span_failures` says how often that happened rather than letting the verdict alone stand for it.",
  },
  {
    key: "S4_corrupted_id",
    contract: "not_found",
    expect: ["not_found"],
    forbid: ["verified"],
    why: "An id with one hex character changed. It is the shape of a citation mangled in transit or truncated in a document, and the contract says a mangled citation is refused rather than resolved.",
  },
  {
    key: "S5_drifted_pin",
    contract: "not_found - a snapshot the store does not hold is refused",
    expect: ["not_found"],
    forbid: ["verified"],
    why: "The pin a caller carries across a re-sync. 95 of 95 protocols had drifted between the golden set and the store, so every citation, every read and every requirement list recorded before the last sync is in this shape. A server that answered from the LATEST snapshot instead would be reporting on bytes the caller did not pin, with no warning - which is the failure this check exists to catch.",
  },
];

const verdictOf = (res) => res.data?.verdict ?? res.data?.status ?? res.__error ?? "unknown";

/**
 * Run the scenarios. `samples` is one entry per measured protocol:
 * `{ rfc, snapshot_id, recorded_snapshot_id, row_citation_id, duplicate_text }`.
 *
 * `call(name, args, bucket)` is the harness's own counting wrapper, so these calls land in
 * the VERIFY bucket and are excluded from the CALLS figure, which is what the README
 * already promises and what makes the CALLS correction below honest.
 */
export async function runVerifyScenarios(samples, call, limit = 6) {
  const results = [];

  // S1, S2, S4, S5: one citation per measured protocol, paired off against a neighbour so
  // "a different derivation" is always a different document and not the same one twice.
  const byRfc = [...samples].sort((a, b) => a.rfc - b.rfc);
  for (const s of byRfc) {
    if (!s.row_citation_id || !s.snapshot_id) continue;
    const other = byRfc[(byRfc.indexOf(s) + 1) % byRfc.length];
    results.push({
      key: "S1_same_derivation",
      rfc: s.rfc,
      args: { citation_id: s.row_citation_id, snapshot_id: s.snapshot_id },
      verdict: verdictOf(
        await call(
          "verify_citation",
          { citation_id: s.row_citation_id, snapshot_id: s.snapshot_id },
          "verify_citation",
        ),
      ),
    });
    if (other && other.snapshot_id && other.snapshot_id !== s.snapshot_id) {
      results.push({
        key: "S2_other_derivation",
        rfc: s.rfc,
        against: other.rfc,
        args: { citation_id: s.row_citation_id, snapshot_id: other.snapshot_id },
        verdict: verdictOf(
          await call(
            "verify_citation",
            { citation_id: s.row_citation_id, snapshot_id: other.snapshot_id },
            "verify_citation",
          ),
        ),
      });
    }
    results.push({
      key: "S4_corrupted_id",
      rfc: s.rfc,
      args: { citation_id: corruptId(s.row_citation_id), snapshot_id: s.snapshot_id },
      verdict: verdictOf(
        await call(
          "verify_citation",
          { citation_id: corruptId(s.row_citation_id), snapshot_id: s.snapshot_id },
          "verify_citation",
        ),
      ),
    });
    // A drifted pin is a snapshot id the store no longer holds. The golden set carries one
    // per protocol, but it is now built against the live store, so its pins all resolve -
    // which means the condition has to be constructed rather than waited for. One hex
    // character is the same thing a re-sync does to a caller's stored pin: the document
    // moved on and the id the caller holds names nothing.
    const dead =
      s.recorded_snapshot_id && !byRfc.some((o) => o.snapshot_id === s.recorded_snapshot_id)
        ? s.recorded_snapshot_id
        : corruptSnapshot(s.snapshot_id);
    if (dead && dead !== s.snapshot_id) {
      results.push({
        key: "S5_drifted_pin",
        rfc: s.rfc,
        args: { snapshot_id: dead },
        verdict: verdictOf(
          await call("verify_citation", { snapshot_id: dead, citation_id: s.row_citation_id }, "verify_citation"),
        ),
      });
    }
  }

  // S3: a duplicated sentence, located in the tool's own output rather than invented. 22.6%
  // of the rows over 100 documents are duplicates within their document, so the
  // population is not scarce. The probe is taken from the STRICT list only, because these
  // are stored records and `findCitationMatches` looks in stored records: a candidate row
  // is derived per call and never stored, so its quote is unrecorded BY DESIGN and probing
  // with one would measure the tool's own note rather than its ambiguity handling.
  for (const s of byRfc) {
    if (!s.duplicate_text || !s.snapshot_id) continue;
    const qh = quoteHash(s.duplicate_text);
    const res = await call("verify_citation", { rfc: s.rfc, quote_sha256: qh }, "verify_citation");
    const locators = (res.data?.matches ?? []).map((m) =>
      JSON.stringify([
        m.locator?.block_id ?? null,
        m.locator?.span?.byte_start ?? null,
        m.locator?.span?.byte_end ?? null,
      ]),
    );
    results.push({
      key: "S3_duplicate_quote",
      rfc: s.rfc,
      verdict: verdictOf(res),
      spans: locators.length,
      distinct_spans: new Set(locators).size,
      quote: s.duplicate_text.slice(0, 120),
    });
  }

  return summarise(results, limit);
}

function summarise(results, limit) {
  void limit;
  return VERIFY_SCENARIOS.map((sc) => {
    const rows = results.filter((r) => r.key === sc.key);
    const byVerdict = rows.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
    const spanShort = rows.filter((r) => (sc.min_spans ?? 0) > 0 && (r.distinct_spans ?? 0) < sc.min_spans);
    const nonconform = rows.filter(
      (r) => sc.forbid.includes(r.verdict) || (sc.expect.length > 0 && !sc.expect.includes(r.verdict)),
    );
    const conform = rows.length - nonconform.length - spanShort.length;
    return {
      key: sc.key,
      contract: sc.contract,
      why: sc.why,
      control: sc.control === true,
      checks: rows.length,
      conform,
      conform_pct: rows.length === 0 ? null : Math.round((1000 * conform) / rows.length) / 10,
      by_verdict: byVerdict,
      // A scenario with no checks is UNREACHABLE, not passing. `conform_pct: null` is
      // deliberately not 100: the number a reader would quote does not exist.
      reachable: rows.length > 0,
      unreachable_reason:
        rows.length > 0
          ? null
          : "no input in this store produces this condition; the code path exists and was not exercised, so no claim is made about it",
      span_failures: spanShort.map((r) => [r.rfc, r.spans, r.distinct_spans]),
      span_caveat: sc.span_caveat ?? null,
      // Named, not counted. A scenario that fails on one protocol out of 96 is a defect in
      // that protocol and a number that says "one" does not say where.
      nonconform: nonconform
        .slice(0, 8)
        .map((r) => ({ rfc: r.rfc, against: r.against ?? null, verdict: r.verdict, args: r.args ?? null })),
    };
  });
}

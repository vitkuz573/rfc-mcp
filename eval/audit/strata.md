# Strata audit — where the tool is systematically weak, measured across every axis the corpus holds

Adversarial audit, read-only. No source file was edited, nothing was built, no sync/ingest/reanalyze was
run, the database was opened `readOnly: true`, and the only tool calls were read-only `tools.rfc.*`
operations (`resolve`, `read`, `requirements`, `batch`, `verify_citation`).

**Headline: the low-yield strata are not where the defects are.** Every stratum that looks weak on
`requirements/KB` is weak because _the document states few obligations in the tool's strict reading_,
and that is established from the document's own bytes, not assumed (§7, §8). The defects that do exist
are concentrated in three places the yield metric cannot see: **section addressability**, **the
candidate list that is the only output for 38 documents**, and **the self-diagnostic the tool offers to
explain a zero**.

---

## 0. The frame, and the count drift

|                              |                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `eval/corpus.json`           | 159 documents, `observed_at` 2026-09-25T16:18Z → 2026-09-26T06:30Z                          |
| `snapshots` at first DB read | **166** — 7 more than `corpus.json`: 788, 821, 876, 2328, 2487, 2821, 3207                  |
| `snapshots` at last DB read  | **181**                                                                                     |
| `catalog` rows               | 9,842                                                                                       |
| parser / extractor           | `rfc-text-1.7.3` / `normative-2119-8174-1.6.3`, on **181 of 181** snapshots, `format='txt'` |
| degraded parses              | 4 (792, 854, 2052, 2053). `failures` table: 0 rows.                                         |

The corpus grew 159 → 166 → 181 while this audit ran, all by ingestion of `txt`. Two other published
counts are stale against the same database: `eval/README.md:133` says "151 ingested documents", and the
`search` tool description says "text search covers only the ~121 ingested". A number in this report is
a number _at a timestamp_.

**Frozen analysis set: the 166 documents present at first read.** All per-document figures below are
that set, so they are internally consistent: **13,501 KB** of body text, **43,185** prose blocks,
**7,005** body sections, **10,966** strict requirements, **9,653** non-strict candidates, **57** sentence
fragments. Corpus-wide `req/KB` = **0.812**, best-effort = **1.527**, fragment rate = **1.32 per 1000
prose blocks**.

### Metric conventions, stated because they change conclusions

- **`KB`** = `sum(length(blocks.text))` per document. The only denominator available for all 166.
  Not `catalog.pages`, not `snapshot.bytes`.
- **`req/KB`** = **ratio of sums**: total requirements in the stratum ÷ total body KB in the stratum.
  This is the corpus-level rate. It is _not_ the mean of per-document rates, and where the two disagree
  the disagreement is itself informative, so **`req/KB (median doc)`** is given alongside.
- **best-effort/KB** = (strict requirements + `role=modal` candidates) ÷ KB — the most the tool will
  produce for that document under any input it offers.

---

## 1. Era — the curve is flat, and the reason is not typesetting

| era       | docs | %bodyKB | bodyKB | reqs  | **req/KB** | req/KB (median doc) | best/KB | frag/1k prose blk | blocks skipped | dangling | mean `exact_text` len | mean confidence | `partial` |
| --------- | ---- | ------- | ------ | ----- | ---------- | ------------------- | ------- | ----------------- | -------------- | -------- | --------------------- | --------------- | --------- |
| pre-1985  | 8    | 4.0%    | 538    | **0** | **0.000**  | 0.000               | 1.211   | 2.45              | 34.7%          | 0        | —                     | —               | —         |
| 1985-1994 | 6    | 6.2%    | 832    | 497   | 0.597      | **0.008**           | 1.845   | 1.61              | 31.3%          | 8        | 152                   | 0.8964          | 1.81%     |
| 1995-2003 | 30   | 19.0%   | 2,561  | 2,504 | 0.978      | 0.463               | 1.903   | 0.87              | 24.4%          | 2        | 144                   | 0.8907          | 4.67%     |
| 2004-2012 | 38   | 23.0%   | 3,106  | 2,643 | 0.851      | 0.676               | 1.723   | 2.47              | 22.0%          | 0        | 150                   | 0.8927          | 3.67%     |
| 2013+     | 84   | 47.9%   | 6,464  | 5,322 | 0.823      | 0.673               | 1.270   | 0.74              | 23.2%          | 0        | 162                   | 0.8941          | 2.95%     |

The 1985-1994 row is the reason both columns are needed: the _stratum_ yields 0.597 because RFC 1122
(271) and 1123 (225) carry it, while the _typical document_ in that band yields **0.008** — RFC 959 has
one requirement in 130 KB. A mean-of-ratios table would have hidden both facts.

The apparent pre-1995 collapse is **entirely an input-convention effect, and the tool measures it**.
Conditioning on the document's own BCP-14 stance (the tool's `keyword_usage.stance`, from the
`Status of This Memo` section's own text):

| era × stance          | docs | req/KB    | best/KB | zero-req docs |
| --------------------- | ---- | --------- | ------- | ------------- |
| pre-1985 / unstated   | 8    | 0.000     | 1.162   | 8             |
| 1985-1994 / unstated  | 6    | 0.358     | 1.619   | 3             |
| 1995-2003 / adopts    | 12   | 0.864     | 1.823   | 0             |
| 1995-2003 / disclaims | 2    | 0.779     | 2.632   | 1             |
| 1995-2003 / unstated  | 16   | 0.386     | 1.538   | 8             |
| 2004-2012 / adopts    | 28   | 0.896     | 1.562   | 0             |
| 2004-2012 / disclaims | 1    | 0.000     | 1.247   | 1             |
| 2004-2012 / unstated  | 9    | 0.086     | 0.932   | 5             |
| 2013+ / adopts        | 71   | 0.820     | 1.324   | 1             |
| 2013+ / unstated      | 13   | **0.001** | 0.588   | 11            |

Conditioned on "the document writes BCP-14 keywords in upper case", the extractor's own behaviour is
flat to three decimal places across 46 years:

| era (docs writing upper case) | docs | upper-keyword prose blocks | reqs  | **req / keyword-block** | mean confidence | partial% |
| ----------------------------- | ---- | -------------------------- | ----- | ----------------------- | --------------- | -------- |
| 1985-1994                     | 3    | 411                        | 497   | 1.209                   | 0.896           | 1.81%    |
| 1995-2003                     | 22   | 1,673                      | 2,504 | 1.497                   | 0.891           | 4.67%    |
| 2004-2012                     | 32   | 1,861                      | 2,643 | 1.420                   | 0.893           | 3.67%    |
| 2013+                         | 73   | 3,916                      | 5,322 | 1.359                   | 0.894           | 2.95%    |

**Quantified, not excused:** the pre-1995 loss is 0.823 → 0.000 req/KB, i.e. **100% of the strict
yield**, on 14 documents holding 10.2% of body text. It is not a parser degradation — mean confidence
(0.8907–0.8964), `partial` rate (1.81–4.67%, no monotone trend), `exact_text` length (144–162 chars)
and the emitted term mix (MUST 38–51%, SHOULD 19–26%) are all era-invariant. It is a case-convention
artefact, and the tool already recovers it: pre-1985 best-effort yield is **1.211/KB against
1.270/KB for 2013+**.

**The "notation/tables/fragments degrade before 1995" expectation is false here, and it is quantified.**
Fragment rate does not rise before 1995 (2.45 / 1.61 / 0.87 / 2.47 / 0.74 per 1000 prose blocks); the
two highest bands are 1985-1994 and 2004-2012, and **2013+ is the lowest of all five**. Skipped-block
share falls monotonically to 2004-2012 (34.7% → 22.0%) then rises to 23.2% — that is document
composition, not degradation: pre-1995 memos are 21–28% preformatted (packet diagrams, host tables),
modern ones 9–12%.

**`dangling_headings`: the known defect is genuinely fixed, corpus-wide.** Recomputing
`eval/lib/labelling.mjs:danglingHeadings` over the **whole raw text** of all 166 documents against the
**full** outline — a superset of the bench's 3-sections-per-protocol sample — gives **10 dangling
headings in 2 documents**, against the `63` recorded in `golden.json` and the `0/95` the bench prints
today. Both survivors are almost certainly detector false positives: RFC 1123's are
`3.2.1 3.2.1  Option Negotiation: RFC-854, pp. 2-3` (a duplicated number prefix in a change list) and
RFC 2328's are `11.2 11.2.  Sample routing table, without areas` (same artefact). The 1985-1994 band
carries all 8. **This audit finds no era effect in dangling headings.**

---

## 2. Length — quality does not break; the corpus stops before the band where it might

| body KB    | docs | %bodyKB | reqs  | **req/KB** | req/KB (median doc) | best/KB | zero-req docs | frag/1k |
| ---------- | ---- | ------- | ----- | ---------- | ------------------- | ------- | ------------- | ------- |
| <15 KB     | 21   | 1.4%    | 97    | 0.507      | 0.328               | 1.468   | 8             | 0.00    |
| 15–50 KB   | 63   | 13.9%   | 1,053 | 0.560      | 0.535               | 1.393   | 14            | 2.56    |
| 50–150 KB  | 57   | 37.7%   | 2,945 | 0.579      | 0.480               | 1.302   | 14            | 1.40    |
| 150–400 KB | 22   | 36.0%   | 5,468 | **1.125**  | 1.172               | 1.817   | 1             | 1.18    |
| >400 KB    | 3    | 11.0%   | 1,403 | 0.946      | 0.869               | 1.525   | 1             | 0.00    |

The curve is **non-monotonic and rising with size**: the 150–400 KB band is the best-yielding band in
the corpus on both metrics (1.125 ratio, 1.172 median). The "unusable volume" worry is not supported
here: the largest document is **RFC 3261 at 633 KB / 995 requirements** (1.57 req/KB), returned by the
tool in one `max_results=200` page with a stub on later pages.

**The band that would answer the question does not exist in this corpus.** `snapshot.bytes` bands:
`<50KB` 84, `50-150KB` 65, `150-400KB` 26, `400KB-1MB` 6, **`1-3MB` 0, `>3MB` 0**. No document above
633 KB. "A 5 MB document with 2 000 requirements may be unusable" is untestable here, and the two
largest zero-yield documents (2328 at 513 KB, 8448 at 156 KB) are zero for reasons established in §7,
not because of size.

---

## 3. Purpose — derived from the document, and the derivation is stated

I did not use protocol knowledge. Two independent derivations, both from the document's own stored
section titles and block text:

1. **Self-description** — the text of the section titled `Status of This Memo` / `Status of this Memo`,
   matched against what that section says about itself. 149 of 166 documents state one; 17 (all
   pre-1996, where that section does not exist) do not.
2. **Structural signals** — does a section titled `Conformance` exist; what share of the document's
   `table`+`preformatted` bytes sit under a section titled `IANA …`; is >70% of the body preformatted.

| purpose stratum (derived)                                        | docs  | %bodyKB | reqs  | **req/KB** | req/KB (median doc) | best/KB | zero-req | frag/1k |
| ---------------------------------------------------------------- | ----- | ------- | ----- | ---------- | ------------------- | ------- | -------- | ------- |
| self-declared Standards Track **and** writes the BCP-14 sentence | 94    | 62.4%   | 8,794 | **1.044**  | 0.869               | 1.603   | **0**    | 1.06    |
| self-declared Standards Track, **no** BCP-14 sentence            | 23    | 14.5%   | 1,210 | 0.619      | 0.000               | 1.666   | 12       | 2.18    |
| self-declared Best Current Practice                              | 10    | 2.9%    | 70    | 0.182      | 0.235               | 0.750   | 3        | 0.00    |
| self-declared Experimental                                       | 5     | 1.7%    | 144   | 0.610      | 0.590               | 1.364   | 0        | 0.00    |
| self-declared informational                                      | 17    | 6.2%    | 243   | 0.291      | 0.000               | 0.939   | 10       | 0.42    |
| no self-description found (pre-1995 layout)                      | 17    | 12.3%   | 505   | 0.303      | 0.000               | 1.477   | 13       | 2.53    |
| — has a `Conformance` section                                    | 10    | 10.2%   | 1,218 | 0.886      | 0.934               | 1.205   | 1        | 1.40    |
| — IANA-registry-shaped (>50% of tables in an IANA section)       | **0** | 0.0%    | 0     | —          | —                   | —       | 0        | —       |
| — table-heavy, not registry (≥8% of body in `table` blocks)      | 8     | 6.4%    | 524   | 0.605      | 0.000               | 1.580   | 5        | 1.64    |
| — trace/test-vector shaped (>70% preformatted)                   | 2     | 1.3%    | 0     | 0.000      | 0.000               | 0.017   | 2        | 0.00    |

**The `Conformance`-section proxy is a bad one and I am flagging it rather than leaning on it.** It
selects only 10 of 166, because RFC 8174 removed the section: HTTP Semantics (9110), HTTP/1.1 (9112),
HTTP/2 (9113), HTTP/3 (9114) and QUIC (9000) are all standards-track specifications with **no
Conformance section at all**. Purpose derived that way would label 9110 "not a specification". The
BCP-14-sentence derivation is the one that holds: it separates 94 documents at 1.044 req/KB with
**zero** zero-requirement documents from 23 at 0.619, and it is derived from the document's own
sentence rather than from my knowledge of it.

**Zero documents are IANA-registry-shaped** at the >50% threshold. The maximum IANA table share in the
corpus is 0.47 (RFC 8078: 0.6 KB of 1.2 KB). **The registry stratum of the full RFC corpus is
essentially absent from this corpus** — see §9.3.

---

## 4. Shape — the notation open item, sized honestly

Distribution of `preformatted + table` share of body bytes: min 0.2%, p25 5.4%, **p50 11.4%**, p75
17.9%, p90 25.1%, p99 63.5%, max 88.1%. **34 documents (21.4% of body bytes) are ≥20%.**

| shape                          | docs | %bodyKB | reqs   | **req/KB** | req/KB (median doc) | best/KB | frag/1k |
| ------------------------------ | ---- | ------- | ------ | ---------- | ------------------- | ------- | ------- |
| prose-dominant (≥45% prose)    | 163  | 97.9%   | 10,966 | 0.830      | 0.584               | 1.556   | 1.34    |
| mixed (25–45% prose)           | 1    | 0.8%    | 0      | 0.000      | 0.000               | 0.549   | 0.00    |
| notation-dominant (<25% prose) | 2    | 1.3%    | 0      | 0.000      | 0.000               | 0.017   | 0.00    |

**Only 3 of 166 documents are shaped so that notation/tables dominate.** The premise "a document that
specifies in a field table yields almost nothing" is a real mechanism with a small population here —
and the population is the wrong shape for the claim. RFC 1035 (DNS implementation, 9.6% tables) is the
canonical case and it _does_ yield: **169 candidates, 1.461 best/KB**, from field tables such as
`§4.1.1 Header section format [preformatted] :: Z Reserved for future use. Must be zero in all queries
and responses.` and `§3.3.13 SOA RDATA format [preformatted] :: REFRESH A 32 bit time interval before
the zone should be refreshed.` Those are surfaced as `reason: non_prose_block` candidates, not lost.

**Sizing the actual loss.** Uppercase modal tokens sitting in `table`/`preformatted` blocks, which the
extractor never scans, corpus-wide:

|                                                                                 | count      | documents |
| ------------------------------------------------------------------------------- | ---------- | --------- |
| all stranded uppercase tokens                                                   | 1,689      | 120       |
| − the BCP-14 / RFC 2119 boilerplate sentence (not an obligation)                | −1,159     | −110      |
| = remaining                                                                     | 530        | 42        |
| − ASN.1 field modifiers (`OPTIONAL`, `REQUIRED`, `SEQUENCE`) — not RFC 2119 use | −≈340      | −≈10      |
| **= genuine stranded obligations**                                              | **≈40–60** | **≈20**   |

Concentrated in: 4253 (32, incl. table cell `diffie-hellman-group1-sha1 REQUIRED`), 5936 (19, incl.
`Rules governing name compression of RDATA in an AXFR message MUST abide by the specification in…`),
6455 (13, incl. `The |Sec-WebSocket-Accept| header MUST NOT appear more than once in an HTTP
response.`), 4034 (9), 9117 (6, incl. `One of the following conditions MUST hold true:`), 5246 (5),
3261 (5), 9110 (2), 9651, 9520, 9205, 8446, 8999-family.

**That is ≈0.5% of the 10,966 emitted requirements.** The "notation is unread" open item is real, and
its measured size on this corpus is an order of magnitude smaller than the raw counts suggest — because
the BCP-14 boilerplate (1,159) and ASN.1 (≈340) swamp it. The tool's own
`coverage.keyword_bearing_blocks_skipped` sums to **391 blocks** corpus-wide; 110 of those are the
boilerplate block alone, so **the diagnostic overstates real obligation loss by ~28% of its own count**
while the true figure is ~20 documents. Any estimate of this prize taken from
`keyword_bearing_blocks_skipped` alone is wrong by an order of magnitude.

---

## 5. Language / encoding — the stratum is effectively absent, and what is there is sound

43 of 166 documents contain any non-ASCII byte (26.8% of body text). Total non-ASCII share across the
corpus: **0.6%**; the worst document is **0.072%** (RFC 9650); the mean is 0.0014%. `unreadable_blocks`
(blocks containing U+FFFD) is **0 for every one of the 166 documents**.

| encoding stratum | docs | %bodyKB | reqs  | **req/KB** | req/KB (median doc) | best/KB | frag/1k |
| ---------------- | ---- | ------- | ----- | ---------- | ------------------- | ------- | ------- |
| pure ASCII       | 123  | 73.2%   | 8,004 | 0.810      | 0.535               | 1.641   | 1.73    |
| any non-ASCII    | 43   | 26.8%   | 2,962 | 0.818      | 0.618               | 1.217   | 0.17    |

Citation integrity verified end-to-end on the four worst documents: 10 citations from RFC 9002, 9461,
8833, 8959 → **10/10 `verified`**. Byte, char, code-point and line offsets are all recorded and
consistent.

**This is a null result and must be read as one:** the corpus contains no document where encoding is a
live variable. Box-drawing, curly quotes and an accented author name are the whole population. There is
no IDN, no CJK, no emoji, no mathematical notation, no right-to-left text anywhere in the 166. **Any
claim about encoding quality from this corpus is a claim about 0.0014% non-ASCII.**

---

## 6. Structure — the real defect surface

### 6.1 Flat structure: 4 documents have no addressable body at all

| rfc  | body KB | prose blocks read | sections                  | quality    | `read(section=…)`                  |
| ---- | ------- | ----------------- | ------------------------- | ---------- | ---------------------------------- |
| 854  | 36.2    | 90                | **1** (front_matter only) | `degraded` | `"Section 1 not found in RFC 854"` |
| 792  | 26.1    | 202               | **2**                     | `degraded` | no body section exists             |
| 2052 | 17.1    | 68                | **4**                     | `degraded` | no body section exists             |
| 2053 | 3.5     | 15                | **4**                     | `degraded` | no body section exists             |

All four carry `no_body_sections_detected`; 854 also `no_section_headings_detected`. **83 KB of body
text — 0.6% of the corpus — is unreachable through the section address space**, and this stratum's
fragment rate is **13.33 per 1000 prose blocks, 10× the corpus rate**, which is the same defect showing
up in a second metric.

The text itself is present in blocks and reachable by `read(target="blocks")` and
`read(target="raw_slice", offset_bytes=…)` — RFC 854's numbered sections are plainly visible in a raw
slice (`1.  When a TELNET connection is first established, each end is assumed to originate and
terminate at a "Network Virtual Terminal"…`). So this is **cause (c) at the API surface, not cause (b)**:
the extractor read the text; the section tree a caller navigates by does not exist.

The tool is honest: `quality: degraded`, and 13 requirements carry `in_front_matter` — **10 of which are
RFC 2052's entire normative content** (`A client MUST attempt to contact the target host with the
lowest-numbered priority it can reach`, `A SRV-cognizant client SHOULD use this procedure to locate a
list of servers…`, `A client MUST parse all of the RR's in the reply`). The flag points at the defect
precisely. Honesty is not addressability, and the flag is the only route a caller has to 2052's content.

### 6.2 Polluted outlines: 73 fabricated sections in 15 documents

Label-free test: a `body` section whose `number` is a table cell run, a page header, a protocol line or
a bare phrase cannot be a section number.

**73 such sections in 15 of 166 documents. 118,791 bytes — 0.9% of corpus body text — are filed under
them. 146 `preformatted`/`table` blocks (66 KB) are misfiled this way. All 15 report
`quality: complete`.**

Worst: **RFC 876** — 6 of 8 body sections fabricated, **33.6 KB of 36.3 KB (93% of the document)** filed
under them. The tool's own outline, via `tools.rfc.read(target="outline")`:

```
"" front_matter :: Front Matter
Survey of SMTP Implementations body :: Survey of SMTP Implementations
483 body :: hosts were tested
283 body :: are claimed by the host table to support SMTP
285 body :: hosts were connected to from ISI-VAXA
162 body :: hosts out of the 285 connectable hosts (57%) immediately rejected
115 body :: hosts out of the 285 (40%) gave a positive acknowledgement to a
121 body :: hosts out of the 162 which immediately reject mail to nonexistent
```

The section _numbers_ are counts lifted from the middle of sentences in the 32 KB host table.
`read(section="162")` does return content — a fragment of prose about `"unknown user"` replies — under a
number that means nothing.

Also verified through the tool:

- **RFC 2136** — `"Mneumonic   Value   Description" body` and `"CLASS    TYPE     RDATA    Meaning"
body` (×2). The 10,444-byte `Mneumonic/Value/Description` block is the entire DNS RCODE table.
  `read(section="Mneumonic   Value   Description")` returns it, with `parent_id: null` and
  `path: ["Mneumonic   Value   Description"]` — so it is **not under section 2 at all**, and
  `requirements(scope="2")` cannot reach it.
- **RFC 2300** — `1305 body :: obsoletes 1119 Stan/Rec Network Time Protocol version 2`, a row from
  the table that is 40.4% of the document's body.
- **RFC 1350** — 11 junk sections including the page furniture `Sollins [Page 3]` and `RFC 1350 TFTP
Revision 2 July 1992`, plus `| Opcode | Filename | 0 | Mode | 0 |` (3,092 B).
- **RFC 3988** — 14 junk sections, every one a row of the LSP-MTU table (`LSR | Link | Hop MTU | …`).
- **RFC 8445** — 10 junk sections, 20.4 KB, `ENTITY IP Address Mnemonic name` (8,668 B).
- **RFC 4330** — 8 junk sections, 13.5 KB, `LI Meaning` / `Mode Meaning` / `Stratum Meaning`.
- **RFC 3261** — `handling=required`, `* a=rtpmap:0 PCMU/8000 *`, `Content-Length: 231`.
- **RFC 2845** — `Field Name Data Type Notes`, `Field Name Value Wire Format Meaning`.
- **RFC 2615** — `SONET SDH` ×4. **RFC 6698** — `Value Short description Reference` ×6.

Two are pre-1995; thirteen are 1997–2021. **This is not an era defect.**

**Effect on the yield metric: none, and that is the point.** Clean-outline documents score 0.780
req/KB (ratio) / 0.617 (median doc); polluted-outline documents score 1.013 / 0.480. The two metrics
disagree in sign, so the honest statement is that **outline pollution does not measurably reduce
requirement yield**. The damage is addressability and legibility of the outline, not extraction. A fix
aimed at this stratum would not move `req/KB` at all.

### 6.3 `coverage` does not respond to `scope`

`requirements(scope="2")` and `requirements(scope="3")` on RFC 2136 both return
`prose_blocks_scanned: 166` and identical `blocks_skipped_by_kind` — the same values as the unscoped
call. The candidate totals _do_ respond (7 / 13 / 73), so the filter works; the coverage counters are
document-level, built from the snapshot row (`src/service/rfcService.ts:1371`). Consequence for this
audit and for any per-section measurement: **per-section coverage cannot be measured through the tool
at all**, which is why §4 and §6.2 had to be measured from the database rather than from the API.

---

## 7. The worst strata, and the five worst documents, with cause separated

`requirements/KB` ties at exactly `0.000` for **38 of 166 documents (22.9%)**, holding **2,448 KB =
18.1% of body text**. A tie at zero carries no ordering, so the documented tiebreak is **best-effort
yield** — (strict + `role=modal` candidates)/KB — restricted to documents ≥20 KB so each case is worth
opening. `best/KB = 0.000` is only reachable where the tool offers nothing at all.

Ranking of all zero-requirement documents ≥20 KB by best-effort yield:

| #   | rfc                                                            | year | KB    | req/KB | best/KB   | cands | prose read | pre% | tbl% | outline                     | **cause**     |
| --- | -------------------------------------------------------------- | ---- | ----- | ------ | --------- | ----- | ---------- | ---- | ---- | --------------------------- | ------------- |
| 1   | **8448** Example Handshake Traces for TLS 1.3                  | 2019 | 142.4 | 0.000  | **0.000** | 0     | 20.0 KB    | 84.1 | 0.5  | clean, 18 sections          | **(a)**       |
| 2   | **876** Survey of SMTP implementations                         | 1983 | 36.3  | 0.000  | 0.083     | 3     | 4.4 KB     | 88.1 | 0    | **6/8 sections fabricated** | **(a) + (c)** |
| 3   | **7872** Observations on Dropping of Packets…                  | 2016 | 25.9  | 0.000  | 0.193     | 5     | 19.9 KB    | 22.9 | 0.5  | clean, 15 sections          | **(a)**       |
| 4   | **7624** Confidentiality in the Face of Pervasive Surveillance | 2015 | 54.3  | 0.000  | 0.424     | 23    | 43.2 KB    | 5.1  | 0    | clean, 27 sections          | **(a)**       |
| 5   | **5234** Augmented BNF for Syntax Specifications               | 2008 | 20.3  | 0.000  | 0.443     | 12    | 15.3 KB    | 15.5 | 8.6  | clean, 30 sections          | **(a)**       |

### 1. RFC 8448 — cause (a). The zero is correct.

The document's own text, via `tools.rfc.read`: §1 Introduction reads _"TLS 1.3 [TLS13] defines a new key
schedule and a number of new cryptographic operations. This document includes sample handshakes that
show all intermediate values. This allows an implementation to be verified incrementally…"_ §2 Private
Keys is a hex dump (`modulus (public): b4 bb 49 8f 82 79 30 3d 98 08 36 39 9b 36 c6 98 8c …`). 269
prose blocks scanned; the whole document contains 3 case-insensitive modal tokens, 0 uppercase, 0
stranded, 0 dangling, `keyword_bearing_blocks_skipped: 0`. **The document states no obligations.
0.000 is the right answer.** What it is not is a _specification_ — it is a test-vector document, and it
is the only document in the corpus where the tool returns literally nothing at all.

### 2. RFC 876 — cause (a) for the zero, cause (c) for the structure.

The document says so itself: _"This memo is a survey of implementation status. It does not specify an
official protocol, but rather notes the status of impementation of aspects of a protocol."_ 0 strict
requirements is correct. But **33.6 KB of 36.3 KB (93%) is filed under six section numbers lifted from
mid-sentence digits in the host table** (§6.2), the 32,474-byte host table is a single `preformatted`
block, and the tool reports `quality: complete`. A caller who reads the outline has no way to know the
document's substance lives under `§121 hosts out of the 162 which immediately reject mail to
nonexistent`. The zero is cause (a); the unusability is cause (c).

### 3. RFC 7872 — cause (a).

The document's own Status of This Memo: _"This document is not an Internet Standards Track
specification; it is published for informational purposes."_ 98 prose blocks / 19.9 KB read, 15 clean
sections, 0 stranded, 0 dangling. 5 candidates from 7 modal tokens. **Correct zero.**

### 4. RFC 7624 — cause (a).

62,260 characters of raw text contain **0** uppercase RFC 2119 tokens and 26 lower-case ones. 43.2 KB
of prose read across 27 clean sections, 23 candidates, 0 stranded. **Correct zero.** It is a BCP 195
threat model: no `Conformance` section, no BCP-14 sentence.

### 5. RFC 5234 — cause (a), with a small notation component.

Clean 30-section outline, 89 prose blocks / 15.3 KB read, 12 candidates, 0.443 best/KB. The document
defines a notation; its normative content is `Appendix B Core ABNF of ABNF` = 11 `preformatted` blocks
(975 B) + 4 `table` blocks. 0.000 is essentially correct for a prose-strict reading of a
meta-notation document.

### A sixth case the metric hides and the corpus does not

**RFC 2328 (OSPF Version 2), 513 KB — the largest document in the corpus with zero requirements.**
Best-effort 0.879/KB from 422 candidates, 451 prose blocks / 313.7 KB read, 875 of 1,425 blocks
scanned. **524,985 characters of raw text contain 0 uppercase RFC 2119 tokens and 564 lower-case
ones.** Cause (a), unambiguously — and it is the largest single block of lowercase-obligation text in
the corpus. Same shape for **RFC 8200** (IPv6 Specification, 2017, Internet Standard: 143 lower-case
modal tokens, 0 upper-case, 110 candidates) and **RFC 3986** (URI Generic Syntax: 186 lower-case,
0 upper-case, 153 candidates).

**Conclusion for §7: not one of the worst strata is a cause-(b) or cause-(c) requirement-extraction
defect. The ceiling test proves it corpus-wide** — §8.

---

## 8. The ceiling test — the one measurement that separates (b) from (c) at corpus scale

A `requirements` row can only come from a _scannable prose block containing an upper-case RFC 2119
keyword_. So: count those blocks per document — **case-sensitively**; SQLite `LIKE` is
case-insensitive, and a `LIKE`-based count gives 15,564 blocks, 2× the truth, and would invert this
conclusion — and compare with the requirements emitted.

- Scannable prose blocks containing ≥1 upper-case keyword: **7,861** across 130 of 166 documents.
- Requirements emitted: **10,966** → **1.395 per keyword-bearing block**.
- **Minimum across the corpus: 1.000.** Median 1.316, max 3.000.
- **Documents emitting fewer requirements than keyword-bearing prose blocks: 4**, all accounted for:
  2181 (1 block, 0 reqs) and 8174 (1 block, 0 reqs) each have exactly one keyword-bearing block and it
  _is_ the BCP-14 boilerplate; 2119 (7/3) and 3226 (5/4) are the two documents that _are_ about the
  keyword convention.
- **Documents with ≥20 keyword-bearing prose blocks and zero requirements: 0.**

**There is no measurable (b) or (c) loss on the strict path inside this corpus.** Every block the
extractor read that could carry a strict requirement yielded at least one. The upper bound on extractor
loss here is four documents' worth of boilerplate.

**One counted-not-hidden under-report, by design:** 1,174 rows carry
`multiple_terms_in_sentence / keywords_collapsed_to_one_row`. Uppercase keyword tokens per such row:
2 → 1,113, 3 → 51, 4 → 10. That implies **1,245 obligations not emitted as separate rows — 10.2% on
top of 10,966**, evenly spread across eras (61 / 321 / 300 / 492). **Every `req/KB` in every table in
this report, and in the bench, is a lower bound by ~10%.**

**The one place (c) _is_ measurable is the non-strict path — and it is a precision problem, not a
recall one.** 621 of 9,596 candidates (**6.5%**), across 141 documents, carry
`reason: non_prose_block`:

- **111 are the BCP-14 boilerplate.** For **RFC 8174** the top two candidates _are_ the boilerplate
  sentence, both tagged `role: modal, shape: demand` — the tool's own RFC-2119-§3 action-verb test
  asserting that a definition of the keywords is a demand.
- **29 are page furniture.** For **RFC 854** — a document whose entire candidate list is 77 rows —
  **15 are page headers**: `Network Working Group J. Postel Request for Comments: 854 J. Reynolds ISI
Obsoletes: NIC 18639 May 1983`, and `RFC 854 May 1983` ×13, each tagged `keyword: "May", role:
modal, shape: demand`. **The keyword is the month.**
- **≈86 are ASN.1** `OPTIONAL`/`REQUIRED` field modifiers (4120: 39, 5280: 28, 4511: 19).
- **The remainder are real obligations the strict pass cannot see, correctly surfaced**: 1122 `o MUST
be able to send and receive packets using RFC-894 encapsulation;`; 1123 `Implementations MUST contain
the fix for this problem: the sender (i.e., the side originating the DATA packets) must never
resend…`; 3261 `Any response chosen for immediate forwarding MUST be processed as described in
steps…`; 5936 `QR MUST be 0 (Query)`; 9110 `*Note:* For historical reasons, a user agent MAY change
the request method from POST to GET`; 9117 `One of the following conditions MUST hold true:`; 5246
  `the keyAgreement bit DH_RSA MUST be set if the key usage extension is present`; 2328 `The IP
checksum must be correct.`; 1035 `NSDNAME A <domain-name> which specifies a host which should be
authoritative…`; 2865 `0 This attribute MUST NOT be present in packet.`

So `non_strict_candidates` is simultaneously **the only compliance output for 38 documents and ~6.5%
contaminated on exactly the documents where it is the only output** — and the contamination is
concentrated in pre-1995 and table-heavy documents, with a page header and a definition ranked first on
two of them.

### And the self-diagnostic that is supposed to make a zero explicable is wrong where it matters most

`keyword_usage.stance` over 166 documents: **111 `adopts`, 3 `disclaims`, 52 absent.**

| stance           | docs   | %bodyKB   | reqs  | **req/KB** | req/KB (median doc) | best/KB | frag/1k | zero-req |
| ---------------- | ------ | --------- | ----- | ---------- | ------------------- | ------- | ------- | -------- |
| `adopts`         | 111    | 67.4%     | 9,243 | 1.016      | 0.763               | 1.590   | 1.02    | 1        |
| `disclaims`      | 3      | 3.8%      | 555   | 1.088      | **0.000**           | 2.305   | 1.34    | 2        |
| **field absent** | **52** | **28.9%** | 1,168 | 0.300      | 0.000               | 1.278   | 2.10    | **35**   |

- **RFC 1812: `stance: "disclaims"`, with `meaning`: _"The document states that it does not use the
  RFC 2119 requirement language, so a zero requirement count is expected and is not a gap in
  extraction."_ — in the same response as `coverage.total_requirements: 555`.** The matched sentence is
  a routing rule: `Routing information for routes which the router does not use (router S in the above
example) MUST NOT be passed to any other router.` **The response contains both "555 requirements" and
  "a zero requirement count is expected".** That is self-contradictory output, on the
  highest-requirement-density document in the corpus.
- **RFC 3986: `stance: "disclaims"` — also false.** Matched sentence: `Protocols that do not use the
MIME message header syntax, but that do allow some form of tagged metadata to be included within
messages, may define their own syntax for d…` The keyword matched is `may`, in ordinary prose.
- RFC 2181: `stance: "disclaims"` — **correct**: `This memo does not use the oft used expressions MUST,
SHOULD, MAY, or their negative forms.` Reported as a `mention` with `disposition: definition`, not a
  requirement. Right answer.
- **False-positive rate of the disclaimer detector: 2 of 3 (67%)**, and both false positives are on
  documents with high modal density — exactly where the regex
  `\b(?:does not use|…)\b[^.]{0,120}\b(?:MUST|SHALL|…)\b` is most likely to fire on ordinary prose.
- **The field is absent for 52 of 166 documents (31%), holding 28.9% of body text and 35 of the 38
  zero-requirement documents** — including the three largest lowercase-obligation documents: 2328 (564
  modal tokens), 8200 (143), 3986 (186). For those, a caller gets `total_requirements: 0`, no
  `keyword_usage`, and a `caveat` telling them to read `non_strict_candidates` — with no field stating
  that the document never adopted the convention.
- A fourth disclaimer is present and **not** detected: RFC 6455 `Requirements phrased in the
imperative as part of algorithms (such as "strip any leading space characters"…)` is reported as
  `adopts` on the strength of its BCP-14 sentence.

---

## 9. Can any of this generalise? The corpus is 1.84% of the RFC corpus, and the frame is skewed

`catalog` = 9,842 rows; `snapshots` = 181. **1.84%.** The corpus is one bench golden set
(`golden.json`, 100 protocols) plus `golden-ext.json`'s remainder, and the golden set was cut by
`sorted by RFC number → 10 equal strata → 10 evenly spaced from each` (`eval/README.md:23`) — a
deliberately even spread over **publication order**, not over document kind.

### 9.1 Axes on which the corpus is measurably skewed

| axis                       | catalogue  | ingested  | skew            |
| -------------------------- | ---------- | --------- | --------------- |
| Internet Standard (`std`)  | 1.3%       | **13.8%** | **×10.3 over**  |
| Draft Standard (`ds`)      | 1.4%       | 4.4%      | ×3.2 over       |
| BCP                        | 3.4%       | 6.1%      | ×1.8 over       |
| **Informational (`inf`)**  | **30.6%**  | **11.0%** | **×0.36 under** |
| Historic (`hist`)          | 3.6%       | 1.1%      | ×0.31 under     |
| unknown status             | 9.0%       | 1.1%      | ×0.12 under     |
| 1985–1994                  | 8.3%       | 3.3%      | ×0.40 under     |
| pre-1985                   | 8.8%       | 4.4%      | ×0.50 under     |
| 2013+                      | 32.5%      | 48.6%     | ×1.49 over      |
| obsoletes another RFC      | 12.9%      | 37.6%     | ×2.9 over       |
| stream `Editorial`         | 3 docs     | **0**     | absent          |
| stream `Independent`       | 4.4%       | 2.8%      | ×0.63 under     |
| **offers no `txt` format** | **7 docs** | **0**     | **absent**      |

The two large biases run in **opposite directions on the same metric**: the corpus over-samples Internet
Standards by ×10.3 — the 1980s lowercase memos that drag `req/KB` down — and under-samples
informational RFCs by ×0.36, which would drag it down further. They partly cancel, which is precisely
why **the corpus aggregate `req/KB` is not interpretable as an estimate of the corpus-wide `req/KB`**,
and why no single headline number should be quoted from it.

### 9.2 Axes the frame cannot test at all

`catalog` populates `abstract`, `group`, `area`, `pages` and `keywords` **only for ingested rows**:

| field                                     | populated in ingested | populated in the 9,661 not ingested |
| ----------------------------------------- | --------------------- | ----------------------------------- |
| title, published, status, stream, formats | 100%                  | 100%                                |
| abstract                                  | 90.1%                 | **0%**                              |
| group                                     | 92.8%                 | **0%**                              |
| pages                                     | 92.8%                 | **0%**                              |
| keywords                                  | 78.5%                 | **0%**                              |
| area                                      | 69.1%                 | **0%**                              |

**Length cannot be used to argue representativeness, because the catalogue has no length for 98% of its
own rows.** Nor can group type (skew ×54 — the 168 rows that _have_ a group _are_ the ingested rows),
nor area, nor abstract. Only publication year, status, stream and the format list can be compared
across the whole frame, and only status and stream are skewed enough to matter.

### 9.3 Strata of the full RFC corpus this corpus does not contain at all

1. **Documents >1 MB.** Bands `1–3 MB` and `>3 MB` are empty; max is 633 KB. The entire
   large-document regime — where "2 000 requirements may be unusable" is a real question — is
   unmeasured. 6 documents above 400 KB; 0 above 1 MB.
2. **The RFCXML parser.** `assets` holds **43 `xml` assets / 8.1 MB**, and all 43 belong to snapshots
   whose `format` is `txt`. `snapshots` = 181 rows, **181 `txt`, 0 `xml`**; **0 snapshots hold both a
   txt and an xml asset**. `src/parse/rfcXml.ts` and `src/parse/xml.ts` are exercised by **zero** of the
   181 documents, while 1,378 catalogue documents (14.0%) offer XML, of which 43 (23.8% of ingested,
   ×1.70 skew) sit in the corpus in txt form only. An entire code path is unmeasured.
3. **Registry-shaped documents.** **0 of 166** put >50% of their tables in an IANA section; the maximum
   is 0.47. The corpus contains almost no pure IANA-registry RFC — the stratum where "the document's
   entire normative content is a table" is the normal case, not the exception.
4. **Documents with no `txt` format: 7 in the catalogue, 0 ingested.** The format the tool actually
   parses is unavailable for them, and nothing here measures that.
5. **Re-ingestion / version change.** **0 documents have more than one snapshot.** The "a re-sync never
   mutates an existing snapshot" guarantee and the `snapshot_redirects` path are untested by the corpus.
6. **Errata as a stratum.** 140 errata rows across 10 documents; **0 errata-only or errata-shaped
   documents**. The overlay behaviour has no representative population.
7. **Non-ASCII as a stratum.** Max 0.072%. No IDN, CJK, emoji, mathematical notation or RTL text in 166
   documents.
8. **`relations`: 8 rows.** The dependency graph is essentially unpopulated, and 68 of 166 documents
   obsolete something (×2.9 skew), so it is weighted toward the obsoleting end.
9. **Test suites / benchmark documents.** 2 (8448, 876). A corpus spread evenly over RFC number gets
   very few, because they cluster in a handful of series.
10. **Every stream except IETF is under-represented**: `Editorial` 0/3, `IRTF` 2/128, `IAB` 2/134.
11. **Two-column plain-text artefacts.** `(continued):` interleaving appears in **1 document** (6455, 1
    block) — this corpus cannot say anything about multi-column `.txt` reconstruction. An earlier draft
    of this audit cited RFC 2626 as an instance; **2626 is not in the corpus and that claim is
    withdrawn.**

### 9.4 What may be trusted, and what may not

**Trustworthy, because it is an invariant over 7,861 blocks rather than a rate:**

- the strict extractor's per-block yield is ≥1.000 everywhere in the corpus, and its mean confidence,
  `partial` rate and `exact_text` length are era-invariant to three significant figures;
- `requirements/KB` is a lower bound by ~10% (`keywords_collapsed_to_one_row`);
- citation verification is sound on the encoding stratum that exists (10/10).

**Not trustworthy as a corpus-wide estimate: any aggregate.** The frame is 1.84%, skewed ×10.3 on one
status and ×0.36 on another in opposite directions, cut by an even spread over RFC number, and it
contains **zero** documents above 1 MB, **zero** XML parses, **zero** registry-shaped documents and
**zero** re-ingestions. A number measured here is a statement about _the golden set's sampling rule_,
not about the RFC corpus.

**The corpus is not the problem; the sampling rule is.** A fix effort aimed at "the 38 zero-requirement
documents" would be aimed at nothing — §7 and §8 show those documents state few obligations and the
extractor read them. A fix effort aimed at the surfaces below would be aimed at 19 documents, 1.9% of
body text, and the only output of 38 documents.

---

## 10. Summary table

`req/KB` is ratio-of-sums. `frag/1k` is sentence fragments per 1000 prose blocks.

| stratum                               | docs   | %bodyKB   | req/KB                       | frag/1k   | dominant cause (a/b/c) | evidence                                                                                                                                                                                      |
| ------------------------------------- | ------ | --------- | ---------------------------- | --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-1985                              | 8      | 4.0%      | 0.000                        | 2.45      | **a**                  | 0 uppercase RFC 2119 tokens in raw text; 8/8 `stance` absent; best-effort 1.211/KB; dangling 0                                                                                                |
| 1985-1994                             | 6      | 6.2%      | 0.597 (median doc **0.008**) | 1.61      | **a**                  | only 3 of 6 write upper case (1122/1123/959); conditioned on that 1.209 req/kw-block, conf 0.896; 8 dangling (all 1123, detector artefacts)                                                   |
| 1995-2003                             | 30     | 19.0%     | 0.978                        | 0.87      | **a**                  | 12/30 adopt BCP 14 at 0.864; 16 absent at 0.386; 1.497 req/kw-block                                                                                                                           |
| 2004-2012                             | 38     | 23.0%     | 0.851                        | 2.47      | **a**                  | 28/38 adopt at 0.896; 9 absent at 0.086; 1.420 req/kw-block                                                                                                                                   |
| 2013+                                 | 84     | 47.9%     | 0.823                        | 0.74      | **a**                  | 71/84 adopt at 0.820; **13 absent at 0.001 req/KB** (DNS Terminology ×3, 8200, 8448, 7624, 9696, 8901, 8903, 9217, 7258, 7872)                                                                |
| <15 KB                                | 21     | 1.4%      | 0.507                        | 0.00      | a                      | 8 zero-req, all self-declared informational or terminology                                                                                                                                    |
| 15–50 KB                              | 63     | 13.9%     | 0.560                        | 2.56      | a                      | 14 zero-req; 39 junk sections live in this band                                                                                                                                               |
| 50–150 KB                             | 57     | 37.7%     | 0.579                        | 1.40      | a                      | 14 zero-req (2328, 3989, 3986, 8200, 9696, 7719)                                                                                                                                              |
| 150–400 KB                            | 22     | 36.0%     | **1.125**                    | 1.18      | a                      | best band in the corpus on both metrics; 1 zero-req                                                                                                                                           |
| >400 KB                               | 3      | 11.0%     | 0.946                        | 0.00      | a                      | 2328 (0 reqs / 564 lower-case modals), 3261 (995), 9110 (408)                                                                                                                                 |
| std-track + BCP-14 sentence           | 94     | 62.4%     | **1.044**                    | 1.06      | —                      | **0 zero-req documents**; 1.603 best/KB                                                                                                                                                       |
| std-track, no BCP-14 sentence         | 23     | 14.5%     | 0.619                        | 2.18      | a                      | 12 zero-req; 2328 / 8200 / 3986 among them                                                                                                                                                    |
| self-declared BCP                     | 10     | 2.9%      | 0.182                        | 0.00      | a                      | 3 zero-req; the shortest band                                                                                                                                                                 |
| self-declared informational           | 17     | 6.2%      | 0.291                        | 0.42      | a                      | 10 zero-req; 15 junk sections                                                                                                                                                                 |
| self-declared experimental            | 5      | 1.7%      | 0.610                        | 0.00      | a                      | 0 zero-req                                                                                                                                                                                    |
| no self-description (pre-1995 layout) | 17     | 12.3%     | 0.303                        | 2.53      | a                      | 13 zero-req; 8 dangling; 16 junk sections                                                                                                                                                     |
| has a `Conformance` section           | 10     | 10.2%     | 0.886                        | 1.40      | —                      | **bad proxy**: 9110/9112/9113/9114/9000 are specifications without one                                                                                                                        |
| IANA-registry-shaped                  | **0**  | 0.0%      | —                            | —         | —                      | max IANA table share in the corpus = 0.47                                                                                                                                                     |
| trace/test-vector (>70% preformatted) | 2      | 1.3%      | 0.000                        | 0.00      | **a**                  | 8448, 876; both documents say they specify nothing                                                                                                                                            |
| table-heavy non-registry (≥8% body)   | 8      | 6.4%      | 0.605                        | 1.64      | a                      | 1035 yields 169 candidates from its field tables                                                                                                                                              |
| prose-dominant (≥45% prose)           | 163    | 97.9%     | 0.830                        | 1.34      | a                      | —                                                                                                                                                                                             |
| notation-dominant (<25% prose)        | 2      | 1.3%      | 0.000                        | 0.00      | **a**                  | 8448, 876                                                                                                                                                                                     |
| pure ASCII                            | 123    | 73.2%     | 0.810                        | 1.73      | a                      | —                                                                                                                                                                                             |
| has non-ASCII bytes                   | 43     | 26.8%     | 0.818                        | 0.17      | a                      | max 0.072%; 0 `unreadable_blocks`; 10/10 citations verified                                                                                                                                   |
| clean outline                         | 151    | 86.2%     | 0.780                        | 1.36      | a                      | 0 junk sections                                                                                                                                                                               |
| **outline polluted**                  | **15** | **13.8%** | 1.013                        | 1.03      | **c**                  | **73 junk sections; 118,791 B (0.9% of body) misfiled; 146 preformatted/table blocks (66 KB); all 15 report `quality: complete`. Yield impact: none measurable — the loss is addressability** |
| **no addressable body (≤4 sections)** | **4**  | **0.6%**  | 0.109                        | **13.33** | **c**                  | **854/792/2052/2053: 83 KB unreachable by `read(section=…)`; all `degraded`; 13 requirements flagged `in_front_matter`, 10 of them 2052's whole normative content**                           |
| `stance: adopts`                      | 111    | 67.4%     | 1.016                        | 1.02      | —                      | 1 zero-req doc (8174)                                                                                                                                                                         |
| `stance: disclaims`                   | 3      | 3.8%      | 1.088                        | 1.34      | **c**                  | **2 of 3 detections false. 1812: `stance: disclaims` + "a zero requirement count is expected" in the same response as `total_requirements: 555`**                                             |
| `stance` absent                       | 52     | 28.9%     | 0.300                        | 2.10      | a                      | holds 35 of the 38 zero-requirement documents, incl. 2328 (564 modals), 8200 (143), 3986 (186)                                                                                                |

---

## 11. Ranked strata that deserve engineering attention, with the size of each prize

Ranked by measured size, not by how bad the number looks.

| rank  | stratum                                                                        | documents                         | measured size of the prize                                                                                                                                                                                                                                                                                                                                                                                                                    | why it is a defect and not a document property                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **The candidate list on the 38 zero-requirement / 52 stance-absent documents** | 38 docs, 2,448 KB (18.1% of body) | **621 of 9,596 candidates (6.5%) come from `non_prose_block`; 140 of them are the BCP-14 boilerplate or page furniture.** RFC 854: 15 of its 77 candidates are `RFC 854 May 1983`. RFC 2300's top candidate is `Network Working Group … Request for Comments: 2300 J. Postel, Editor Obsoletes: 2200`, tagged `keyword: "May", role: modal, shape: demand`. RFC 8174's top two candidates are the keyword definition, tagged `shape: demand`. | This list is the _only_ compliance output for these documents. The contamination is not a recall loss — it is a caller copying a page header into a contract. It concentrates in the same pre-1995 / table-heavy documents that have no other output, and the tool's own `shape: demand` verdict endorses it.                                     |
| **2** | **`keyword_usage` false `disclaims`**                                          | 3 detections, **2 false**         | **A self-contradictory response: `stance: "disclaims"` + "a zero requirement count is expected and is not a gap in extraction" on RFC 1812, which returns 555 requirements.** False-positive rate 67% (2/3), both failures on high-modal-density documents. One real disclaimer (6455) missed. `stance` **absent for 52/166 (31%)**, holding 28.9% of body and 35 of the 38 zeros.                                                            | The field exists to make a zero explicable. On the document with the highest requirement density in the corpus it asserts the opposite of what the same response reports. On 52 documents the field is missing entirely, including the three largest lowercase-obligation texts, so the zero is not explicable by the tool's own output.          |
| **3** | **Polluted outlines: fabricated section numbers**                              | 15 docs, 1,869 KB (13.8% of body) | **73 junk sections; 118,791 bytes (0.9% of corpus body) filed under them; 146 preformatted/table blocks (66 KB) misfiled; RFC 876 alone 33.6 KB of 36.3 KB (93%); RFC 2136 10.4 KB orphaned with `parent_id: null` so `scope="2"` cannot reach it.** All 15 report `quality: complete`.                                                                                                                                                       | A table row or a page header is not a section number, and the test is label-free. The outline is the address book a caller navigates by; 73 of its entries are not addresses. Present in 13 documents from 1997–2021, so not an era artefact. **Measured yield impact: none** — the harm is addressability, so a fix here will not move `req/KB`. |
| **4** | **Documents with no addressable body**                                         | 4 docs, 83 KB                     | **83 KB unreachable via `read(section=…)`; fragment rate 13.33/1000, 10× the corpus rate. 13 requirements flagged `in_front_matter`, 10 of which are RFC 2052's entire normative content.**                                                                                                                                                                                                                                                   | The extractor read all of it (90/202/68/15 prose blocks). The section tree does not exist. `quality: degraded` and the `in_front_matter` flag are honest, but honesty is not addressability, and the flag is the only route a caller has to 2052's content.                                                                                       |
| **5** | **Genuinely stranded obligations in tables/preformatted text**                 | ≈20 docs                          | **≈40–60 obligations against 10,966 emitted = ≈0.5%.** Concentrated: 4253 (32), 5936 (19), 6455 (13), 4034 (9), 9117 (6), 5246 (5), 3261 (5), 9110 (2).                                                                                                                                                                                                                                                                                       | Real and unreachable by the strict path. The prize is small **because** 1,159 of the 1,689 apparently-stranded tokens are the BCP-14 boilerplate and ≈340 are ASN.1 `OPTIONAL`/`REQUIRED`. `keyword_bearing_blocks_skipped` (391 blocks) therefore overstates this by an order of magnitude; any sizing taken from that field alone is wrong.     |
| **6** | **Requirement count as a lower bound**                                         | all 128 docs with requirements    | **1,174 rows flagged `multiple_terms_in_sentence / keywords_collapsed_to_one_row` imply 1,245 further obligations = 10.2% on top of 10,966.** Evenly spread across eras.                                                                                                                                                                                                                                                                      | Not a defect — a documented, flagged design decision. It is on this list because every `req/KB` in every table here, and in the bench, is understated by ~10%, and the flag is the only signal.                                                                                                                                                   |
| **7** | **`coverage` does not respond to `scope`**                                     | all                               | **Per-section coverage is unmeasurable through the tool.** `scope="2"` and `scope="3"` on RFC 2136 both report `prose_blocks_scanned: 166` and identical `blocks_skipped_by_kind`, identical to the unscoped call, while candidate totals correctly differ (7 / 13 / 73).                                                                                                                                                                     | The filter works and the counters do not, so a caller cannot tell how much of the section they asked about was read. This is why the junk-section and stranded-text strata in §4 and §6.2 had to be measured from the database rather than the API.                                                                                               |

**Not on this list, and that is the point of the audit:** the pre-1985 and 1985-1994 eras (14 docs,
10.2% of body, `req/KB` 0.000 and 0.597 with a median document at 0.008). The tool's own
`keyword_usage.stance` and `non_strict_candidates` recover it — best-effort yield 1.211 and 1.845/KB
against 1.270/KB for 2013+ — and the ceiling test shows the extractor loses nothing on the strict path
for any document that writes the keywords. **The degradation before 1995 is in the RFCs, not in the
tool.**

---

## Appendix — how each number was obtained

- **Corpus frame, per-document metrics, block/section/requirement aggregates, junk sections, stranded
  tokens, ceiling test, era×stance cross-tab**: `new DatabaseSync(~/.local/share/rfc-mcp/corpus.sqlite,
{readOnly:true})`, queried directly. 13,501 KB of `blocks.text` across 166 snapshots. "Scannable" =
  blocks of kind `paragraph`/`list_item`/`unknown` in sections whose kind is not
  `authors`/`index`/`references` — the extractor rule at `src/analysis/normative.ts:169,171`.
- **`dangling_headings`**: `danglingHeadings()` imported from `eval/lib/labelling.mjs`, run over each
  document's **entire** raw text against its **full** outline — a superset of the bench's
  3-sections-per-protocol sample. 10 headings / 2 documents.
- **`requirements` sweep**: `tools.rfc.batch`, 10 `requirements` ops per call, 17 calls, all 166
  documents, `include_candidates: true, include_mentions: false, max_results: 1` (whole-document
  counters appear on every page). `status: ok` for 166/166.
- **`keyword_usage` / `stance`**: the same sweep with `include_candidates: false`, plus targeted calls on
  1812, 3986, 8200, 2328, 6455 to read the `meaning` string and the full `notes` array.
- **Candidate contamination**: a second full sweep collecting `reason`, `keyword`, `role`, `shape` and
  `exact_text` for all 9,596 candidates; boilerplate and page-furniture identified by pattern over the
  candidates' own text.
- **Citation integrity on the encoding stratum**: 10 `verify_citation` calls on citations from RFC 9002,
  9461, 8833, 8959 — the four worst non-ASCII documents. 10/10 `verified`.
- **Structural defects**: `tools.rfc.read(target="outline")` on 876, 5234, 2300, 2136, 854, 792, 2052,
  2053, plus `read(section=…)`, `read(target="raw_slice", offset_bytes=…)` and `requirements(scope=…)`
  where the outline was the thing in question.
- **Case sensitivity**: SQLite `LIKE` is case-insensitive. Every keyword-presence count here uses
  `instr()` (case-sensitive). A `LIKE`-based count overstates the uppercase-keyword block population by
  2× (15,564 vs 7,861) and would have inverted the §8 conclusion.
- **Ratio vs mean**: `req/KB` is ratio-of-sums throughout. The first draft of this audit used
  mean-of-per-document-ratios; that metric put the polluted-outline stratum _below_ the clean-outline
  stratum (0.544 vs 0.637) and the report drew a "15% yield penalty" conclusion from it. Ratio-of-sums
  reverses the sign (1.013 vs 0.780), and the two disagree, so §6.2 now claims only what both support:
  outline pollution does not measurably change requirement yield.
- **Scratch work** was done in `/tmp/opencode/strata/`. Nothing outside `eval/audit/strata.md` was
  written; no `dist/`, `src/`, `eval/*.json` or database file was touched. The other entries in
  `git status` are pre-existing modifications from the parent session.

# Conservation audit: does `requirements` + `non_strict_candidates` cover every keyword-bearing sentence?

Adversarial audit of pending-fixes.md item **Y5**, whose proposed invariant is:

> for every section in the corpus, the set of sentences in `requirements` plus the set in
> `non_strict_candidates` must cover every keyword-bearing sentence in that section's `text`.

**Verdict: the invariant as worded is FALSE.** It fails for **506 of the 5 776 sections
(8.76 %)** that contain a keyword-bearing sentence, across **150 of 182 documents**. It also
fails for a second, worse reason that has nothing to do with coverage: **at least 16 emitted
requirement rows state the opposite of the sentence they quote**, and every one of those rows
_satisfies_ the invariant. A coverage law cannot see that, and coverage is the only thing this
invariant measures.

---

## 1. What was measured, and against what

### 1.1 Corpus state

One `DatabaseSync(path, {readOnly: true})`, one `BEGIN` … `COMMIT` for the whole measurement.

|                                                          |                    |
| -------------------------------------------------------- | ------------------ |
| `index_generation` at measurement                        | **1981**           |
| documents (snapshots)                                    | **182**            |
| sections                                                 | **9 955**          |
| blocks                                                   | **65 756**         |
| `requirements` rows                                      | **12 209**         |
| `mentions` rows                                          | **13 747**         |
| sections with ≥ 1 keyword-bearing sentence               | **5 776**          |
| keyword-bearing sentences (the probe set)                | **22 990**         |
| rows a caller can see (requirements + page-1 candidates) | **23 318**         |
| snapshot-id list digest (sha256, first 16)               | `148f6c386755f806` |

The corpus was **being re-ingested while this audit ran**: it held 159 documents at the first
count and 182 at the last, and `index_generation` moved 1953 → 1981. Everything above is from
the single read transaction, so it is internally consistent, but it is a snapshot of a moving
target and any reproduction must pin the snapshot-id list rather than "the corpus". Two
consequences worth stating plainly:

- the strict `requirements` rows are **frozen at ingest** (extractor `normative-2119-8174-1.6.3`)
  while `non_strict_candidates` is **derived per call**, so the invariant couples a stored
  artefact to a computed one;
- a change to the strict extractor does not change the left-hand side of the invariant until a
  re-analysis, and a re-analysis is happening concurrently with this work.

### 1.2 Which text is "the section's `text`"

Established, because the invariant's premise is ambiguous and the ambiguity is itself a finding.

- `sections.text` is the **verbatim** slice the section's `char_start`/`byte_start` span denotes.
  Verified corpus-wide: all **65 756** blocks are exact substrings of their section's text at
  `block.char_start - section.char_start` (0 exceptions), and all **12 209** requirement rows'
  `char_start..char_end` address their own `exact_text` inside their block (0 exceptions). The
  store's coordinates are sound.
- `read --section N` returns `data.text` = the verbatim slice with **page-furniture lines emptied**
  (`blankLines`, `src/service/rfcService.ts:919`). That **shortens the string**, so the field the
  caller reads sentences out of and the offsets the same response hands out are in **different
  coordinate systems**. Measured: **2 877 sections**, **661 415 characters** removed in total;
  worst case RFC 768 §Fields, 1 998 → 1 853 chars (−145). The response says _"Line counts are
  equal in both"_ and never says the offsets diverge. Live: `read(791, "3")` → `text` 975 chars,
  `text_verbatim` 977 chars, `page_furniture_lines: [113, 172]`.
- `read` also truncates `data.text` at the 16 384-byte response budget. **54 sections exceed
  it.** Live: `read(791, "3.1")` → `truncated: true`, 16 384 of 26 780 bytes, and **12
  keyword-bearing sentences live in the 10 396 bytes the caller cannot see**. `byte_cursor` is
  `section.byte_end` (an absolute offset) and `offset_bytes` is **accepted and ignored** for a
  section read — verified live: `read(791, "3.1", offset_bytes=16384)` returns the _same_ first
  16 384 bytes, `truncated: true` again. The only input that honours an offset is
  `target: "raw_slice"`, which returns document bytes, not the section.

So "the section's `text`" is three different byte sequences. The measurement below uses the
**caller-visible rendering** (`blankLines` applied, untruncated) as the probe source, and maps
its offsets back to the verbatim space so rows can be located by position as well as by text.

### 1.3 Probes

Two sentence splitters, as instructed:

- **the tool's own rule** — `splitSentences` from `dist/analysis/normative.js`, the function both
  extractors call, applied to the rendered section text. The strict splitter additionally requires
  the character after the boundary to be able to open a sentence and consults an abbreviation list.
- **an independent stricter rule** — every `[.!?][closers]*` followed by _any_ whitespace ends a
  sentence, whatever follows. Strictly finer; no abbreviation exceptions.

A probe is a sentence containing any of the 13 keyword tokens in **any** case (the brief's list,
which includes `NOT REQUIRED` and `MAY NOT` — neither of which is in the tool's 11-term
vocabulary; see §4.4). Keyword phrases are matched with `\s+` between words, which matters: RFC
text is hard-wrapped, so `MUST\n   NOT` is common and a naive `"MUST NOT" in text` misses it.
Live proof that this is not hypothetical — RFC 1123 §5.2.16 reads
`... right-hand side "domain" MUST\n         NOT interpret or modify ...`.

### 1.4 Rows collected

`requirements` rows from the DB (12 209) plus `non_strict_candidates` rows produced by running
`analyzeNormativeCandidates` on **exactly the block set the service passes it** —
`store.listBlocksWithKeywords(snapshot_id)`, i.e. the seven-stem `lower(text) LIKE` prefilter,
`ORDER BY ordinal LIMIT 5000` — with no `limit`, which means the module default of 500
(`MAX_CANDIDATES`). That is what a caller gets with default arguments today.

**Live response shape actually observed** (RFC 2119 and RFC 3261, via `tools.rfc.*`). The live
server is the `dist/` build stamped 2026-09-26 12:31; `src/` was edited afterwards, so the live
surface is a build _behind_ the working tree. See §1.5 for what that costs.

- `requirements[]`: `id, snapshot_id, rfc, section_id, block_id, term, strength, polarity,
keywords, exact_text, span, context, disposition, flags, citation_id, clause, parse_status,
confidence, section`. Note: **no `stable_citation_id`** on the row despite the column existing
  in the schema, and `actor`/`action`/`condition`/`exception` live inside `clause`, not at top level.
- `non_strict_candidates`: `total, returned, filters, by_keyword, by_keyword_case, by_reason,
by_role, by_shape, by_section, scanned_blocks, unreadable_blocks, sentence_fragments,
ordering, candidates, note`. **No `declarative_specifications`. No `omitted_on_page`. No
  `fragments`** (that key appears only when `sentence_fragments > 0`).
- `coverage`: `total_requirements, returned, section_filter, term_filter, keyword_filter,
blocks_scanned, prose_blocks_scanned, blocks_skipped, blocks_skipped_by_kind,
keyword_bearing_blocks_skipped, unscanned_note`. **No mention counts, no candidate counts, no
  per-section accounting of anything.**
- `capabilities` contains neither the string `declarative` nor `notation_requirements`. **There
  is no third channel.** `mentions` is the only other enumerated list, and it is not part of the
  invariant.

### 1.5 One methodological warning

`src/analysis/normative.ts` was being edited during this audit (mtime 13:06, and
`normative.ts` was the newest file in the tree). The live MCP surface runs `dist/`, so the
numbers above are **the caller-visible state**, measured with `dist/analysis/normative.js`. The
`src/` tree already contains two things the built server does not:

- `analyzeDeclarativeSpecifications` — a keyword-free channel (1 286 rows over 134 documents in
  this corpus; `numeric-bound` 942, `copula-definition` 180, `field-default` 164). Its own
  doc comment lists three obligations the service must meet to expose it; the service meets none,
  and `grep -n declarative src/service/rfcService.ts` returns nothing.
- the `omitted_on_page` stub that stops re-shipping candidate rows on every page.

Both are reported as _latent_, not as live behaviour, and neither is counted in the coverage
numbers.

### 1.6 Judging coverage

Four variants, because the choice matters:

- **V1 doc** — any row in the snapshot whose whitespace-normalised text equals or contains the
  probe. (The most generous reading: "the sentence is somewhere in this document's response".)
- **V2 scope** — any row **in the same section** (what `requirements(scope=N)` gives you).
- **V3 position** — any row whose recorded char range overlaps the probe's computed range.
- **V4 union** — V2 ∪ V3.
- **stricter splitter** — V2 under the independent splitter.

V1, V2 and V4 agree to within 0.15 %; V3 agrees once the offset map is correct (the store's
coordinates are exact, §1.2). Position-based matching adds nothing, which is itself worth
knowing: text matching is the only coverage test that is not already implied.

---

## 2. Coverage rates

### 2.1 The invariant's own unit: the section

|                                                  |  sections |       share |
| ------------------------------------------------ | --------: | ----------: |
| sections with ≥ 1 keyword-bearing sentence       |     5 776 |             |
| **invariant HOLDS** (all such sentences covered) | **5 270** | **91.24 %** |
| **invariant FAILS** (≥ 1 uncovered sentence)     |   **506** |  **8.76 %** |

Of the 506 failing sections: **417** contain at least one sentence that is in **no channel at
all**; **89** contain only sentences that are reached and classified as discourse.

Failing sections by section kind: `status` 194, `references` 162, `body` 116, `authors` 26,
`index` 5, `appendix` 3. **150 of 182 documents** have at least one failing section.

Worst sections by count of uncovered sentences:

| document | section    | kind       | probes | uncovered | mechanism                                                                       |
| -------- | ---------- | ---------- | -----: | --------: | ------------------------------------------------------------------------------- |
| RFC 2178 | References | references |    103 |        99 | section kind skipped (dominant), plus unscanned blocks and text no block covers |
| RFC 2328 | References | references |    100 |        97 | section kind skipped                                                            |
| RFC 1812 | 11         | references |     63 |        62 | section kind skipped                                                            |
| RFC 2828 | 4          | references |     19 |        19 | section kind skipped                                                            |
| RFC 1123 | 7          | references |     16 |        16 | section kind skipped                                                            |

### 2.2 The sentence

22 990 probes, judged by V1 (document level):

| verdict                                            |     count |      share |
| -------------------------------------------------- | --------: | ---------: |
| **EQ** — the row _is_ the sentence                 |    18 686 |    81.28 % |
| **row ⊇ probe** — row strictly contains the probe  |     **0** |     0.00 % |
| **probe ⊃ row** — row is a _fragment_ of the probe |     3 224 |    14.02 % |
| **NONE**                                           | **1 080** | **4.70 %** |

_Reached and classified vs silently dropped_ — the distinction the brief asks for, measured
separately:

|                                                                        |   count | share of the 1 080 |
| ---------------------------------------------------------------------- | ------: | -----------------: |
| **in no channel at all**                                               | **979** |             90.6 % |
| reached as a `mentions` row, `disposition: "definition"`               |     101 |              9.4 % |
| …of those 101, whose only mention falls beyond the 500-row mention cap |   **5** |              0.5 % |

The same under V2 (section-scoped, i.e. what `requirements(scope=N)` returns): 1 112 uncovered
instead of 1 080. The 32-sentence difference is real and is **not** a scoping bug in the tool —
it is duplicate text: the identical sentence is emitted in an unrelated section of the same
document (RFC 5280 ×21, RFC 2178 ×4, RFC 2328 ×3, RFC 4120 ×2, RFC 1812, RFC 3986). A caller who
reads §X and asks for §X's requirements does not get the row, because the row belongs to §Y.

### 2.3 Per tier

Tier A = the sentence contains an upper-case RFC 2119/8174 word (what the strict extractor owns).
Tier B = it contains only a non-strict spelling (what the candidate channel exists for).

| tier                        | probes |     covered |  exact |  fragment-only | uncovered | docs with a gap |
| --------------------------- | -----: | ----------: | -----: | -------------: | --------: | --------------: |
| **A — strict keyword**      | 12 364 | **98.51 %** | 10 555 | 1 625 (13.1 %) |   **184** |              65 |
| **B — non-strict spelling** | 10 626 | **91.57 %** |  8 131 | 1 599 (15.1 %) |   **896** |             140 |

Tier A gaps (184): 65 section-kind skips, 64 `term_quoted`, 37 `keyword_enumeration`, 9 unscanned
blocks, 8 reference entries, 1 no-block. Tier B gaps (896): 591 section-kind skips, 146 fixed
boilerplate, 135 unscanned blocks, 20 reference entries, 3 non-prose, 1 no-block.

The keyword-free population the invariant is **silent** about — 1 286 `declarative` rows in 134
documents — is larger than the 1 080 gaps the invariant does police.

### 2.4 Under the stricter splitter

23 613 probes: EQ 19 728, **row ⊃ probe 442**, probe ⊃ row 2 245, **NONE 1 198 (5.07 %)**.

So the splitter choice moves the gap count by 11 % and is the _only_ thing that makes
"row contains probe" non-zero. Any implementation of the invariant must fix the splitter before
the number means anything, and the bench's probes (built from `read` with the tool's own notion
of a sentence) cannot falsify the universal claim on their own.

---

## 3. Is "coverage by containment" holding the invariant up? No.

The brief's worry: one emitted row containing 50 sentences trivially covers 50 probes.

- **All 23 318 emitted rows are exactly one tool-sentence.** `splitSentences(row.exact_text)`
  returns 1 sentence for every single row. `maxSents = 1`. There is no paragraph-, table- or
  page-swallowing row anywhere in the corpus.
- 21 614 covering (row, probe) pairs cover 21 910 covered probes: **max 9 probes per row, 204 rows
  cover more than one probe, 99.1 % one-to-one.**
- 108 rows exceed 600 characters and the longest is **38 011**; 95 probes are covered by such a
  row. Those are degenerate blocks with no terminal punctuation, where the "sentence" is an ASCII
  table — RFC 9293 Appendix B's probe is 38 233 characters of `+====+` rules and a
  "TCP Requirements Summary" table. That is a defect in what a _sentence_ is, not in coverage.

So the invariant does **not** hold for the wrong reason. It holds because every row is one
sentence. That is a real property worth keeping, and it is also fragile: it is a property of
`splitSentences`, not a guarantee, and the one guarantee the response makes about it is
`maxQuoteChars` being deliberately unenforced.

---

## 4. Attacking the wording

### 4.1 "Cover" is the wrong word: reached and classified is a different property

101 uncovered sentences _are_ reached, and the tool says exactly why — as a `mentions` row with
`disposition: "definition"` and a flag. That is the right answer for RFC 2119 and for RFC 2119's
own key-word definitions. It is also the only place the answer exists.

Live, RFC 2119 §Abstract, the sentences that define MUST / MUST NOT / SHOULD / SHOULD NOT for the
entire corpus:

```
read(2119, "Abstract")  →  "1. MUST   This word, or the terms "REQUIRED" or "SHALL", mean that the …"
requirements(scope="Abstract")            → the sentence is not there
non_strict_candidates(by_section.Abstract) → 7 rows, none of them this sentence
mentions                                   → 3 rows, disposition "definition",
                                             flags ["keyword_enumeration","multiple_terms_in_sentence","in_front_matter"]
```

A caller who filters `mentions` by `disposition == "requirement"` — the documented way to find
normative statements in mentions — sees nothing. A caller who reads only the two channels the
invariant names sees nothing. **"Covered" cannot mean "present in one of two channels" and
cannot mean "reached anywhere"; it has to mean "reached, and the classification that explains why
it is not a requirement is on the response, in the same section, on the page you are holding."**

The 101 are not all benign. 64 of them carry `term_quoted`, and that flag is **wrong** — see 4.2.

### 4.2 `term_quoted` is decided by a 2-character window, and it eats prohibitions

`isQuoted` (`src/analysis/normative.ts:1933`, identical in `dist`):

```ts
const before = text.slice(Math.max(0, index - 2), index);
const after = text.slice(index + term.length, index + term.length + 2);
return (/["'`]/.test(before) && /["'`]/.test(after)) || /["'`]/.test(before) || /["'`]/.test(after);
```

The first disjunct is subsumed by the second and third, so the function reduces to
**"is there a quote character within 2 characters before or after the keyword?"**. RFC prose is
full of quoted field names, and `"domain" MUST NOT interpret …` puts a `"` two characters before
`MUST`. The strict pass then sets `inDefinition`, emits a mention with `disposition: "definition"`
and **no requirement row**; the candidate pass sees an upper-case keyword in a prose block with
`reason === null` and deletes it as "the strict pass already owns it". **Neither channel owns it.**

Live, RFC 1123 §5.2.16 — an absolute prohibition on an SMTP host:

```
read                        →  "…right-hand side "domain" MUST\n NOT interpret or modify the "local-part" of the address."
requirements(scope=5.2.16) →  1 row, and it is the MAY sentence from the next block
non_strict_candidates       →  total 0
document-level requirements →  225 rows, none is it
document-level candidates   →  210 rows, none is it
mentions                    →  men_3a09eb8db576c96d  term MUST NOT  strength absolute  polarity negative
                               disposition "definition"  flags ["term_quoted"]
```

64 sentences in 37 documents carry this flag wrongly. Live-confirmed worst cases:

- RFC 3261 §19.1.1 — `If the user string contains … the user parameter value "phone" SHOULD be present.`
- RFC 8902 §3 — `In the case of TLS 1.3, the "client_certificate_type" SHALL contain a list of …`
- RFC 1122 §3.2.1.8 / §3.3.3, RFC 1123 §5.2.6 / §6.1.3.1, RFC 2181 §3.

The flag is _right_ when the keyword really is quoted (RFC 1122 §1.3.2, `This word or the
adjective "REQUIRED" means that the item is an absolute requirement of the specification.`) and
_wrong_ when a quoted **other** word happens to sit two characters away. Nothing on the response
distinguishes the two cases, and the count of the wrong ones is not reported: an independent
block-level scan finds **68 sentences in 36 documents** reclassified as discourse by the strict
pass and deleted by the candidate pass — 52 by `keyword_enumeration`, 16 by `term_quoted` — of
which the probe-level attribution in §5 puts 64 in the `term_quoted` bucket alone. A flag that
means two opposite things and carries no counter is worse than no flag: it reads as an
explanation.

### 4.3 The worst thing the invariant cannot see: rows that invert their own sentence

This is the finding that decides the wording question. `TERM_PATTERN` is case-**sensitive**, and
its alternation is `MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|…`. Given
`MUST not believe`, the phrase alternative fails and the single keyword `MUST` matches. The row
is emitted with **`polarity: "positive"`**, `confidence: 0.9`, and (almost always) `flags: []`.
The prohibition survives only as the first two characters of `clause.action`.

**16 requirement rows in 9 documents**, every one with the primary keyword immediately followed
by a lower-case `not` and every one with `polarity != negative`:

| row                                            | document                         | `term`/`polarity`     | the sentence                                                                                                                                              |
| ---------------------------------------------- | -------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `req_2a243263bd735f4a`                         | RFC 1812 §3.3.2                  | MUST / **positive**   | "A router MUST not believe any ARP reply that claims that the Link Layer address of another host or router is a broadcast or multicast address."          |
| `req_53d28b02aa25097c`                         | RFC 2865 §2.3                    | MUST / **positive**   | "A forwarding server MUST not modify existing Proxy-State, State, or Class attributes present in the packet."                                             |
| `req_4e9fc2f5b1115424`                         | RFC 2845 §4                      | MUST / **positive**   | "The server MUST not generate a signed response to an unsigned request."                                                                                  |
| `req_8f48074e80f882f0`                         | RFC 2845 §2                      | MUST / **positive**   | "TSIG is a meta-RR and MUST not be cached."                                                                                                               |
| `req_76dcffb7c47de7e6`                         | RFC 3261 §10.3                   | MUST / **positive**   | "A registrar MUST not generate 6xx responses."                                                                                                            |
| `req_97648a21cad4d210`                         | RFC 3335 §5.3.2.1                | MUST / **positive**   | "Again, the user MUST not be allowed to explicitly refuse to send a signed receipt when the sender requests one."                                         |
| `req_637331606fff84f0`                         | RFC 1939 §6                      | MUST / **positive**   | "…the POP3 session does NOT enter the UPDATE state and MUST not remove any messages from the maildrop."                                                   |
| `req_f6e3edd36812a587`                         | RFC 2865 §5.26                   | MUST / **positive**   | "It MUST not affect the operation of the RADIUS protocol."                                                                                                |
| `req_b6abd8ce75ce3443`                         | RFC 3335 §5.3.2.1                | MUST / **positive**   | "Since a request for a signed receipt should always be honored, the user MUST not be allowed to configure the UA to not send a signed receipt…"           |
| `req_4e969c74da57b977`                         | RFC 4271 §9.2                    | MUST / **positive**   | "…a single route doesn't fit into the message… [it] MUST not advertise the route to its peers and MAY choose to log an error locally."                    |
| `req_95f1f32b45438f27`                         | RFC 2845 §4                      | SHOULD / **positive** | "A message containing an unsigned TSIG record … SHOULD not be considered an acceptable response…"                                                         |
| `req_f8e901a90fdc2c7f`                         | RFC 4271 §8.1.5                  | SHOULD / **positive** | "The DelayOpenTimer SHOULD not be running."                                                                                                               |
| `req_c6874916096f282d`, `req_2a93ef7d73067c22` | RFC 5321 §4.2.5, RFC 2821 §4.2.5 | SHOULD / **positive** | "As with temporary error status codes, the SMTP client retains responsibility for the message, but SHOULD not again attempt delivery to the same server…" |
| `req_768da839984722d7`                         | RFC 2821 §2.4                    | MUST / **positive**   | "However, it MUST not be construed as authorization to transmit unrestricted eight bit material."                                                         |
| `req_2a25650bee2bb4b1`                         | RFC 2821 §4.1.1.3                | SHOULD / **positive** | "Sending systems SHOULD not generate the optional list of hosts known as a source route."                                                                 |

All 16 have `confidence: 0.9`; 12 of the 16 have `flags: []` and the other 4 carry flags about
_other_ aspects of the row (`multiple_terms_in_sentence`, `list_marker_stripped_from_clause`) —
none carries a flag about the polarity.

A compliance list built from `requirements[].polarity` tells the RFC 3261 implementer that a
registrar **MUST** generate 6xx responses. All 16 of these sentences are **covered** — the
invariant passes them. There is also a related class with the same shape: **25 rows in 18
documents** where the RFC wrote `MAY NOT` (not an RFC 2119 keyword at all) and the row says
`term: MAY, polarity: positive` — e.g. RFC 4271 §9.1.1 `req_2bd96e78d49ec2c3`, whose
`clause.action` is `"NOT serve as an input to the next phase of route selection; …"` while every
structured field says MAY / positive / complete / 0.9.

**This is why "cover" is the wrong word and why the invariant cannot be the whole contract.**
Reach is necessary and not sufficient. A contract that only counts reach will be reported as
green while shipping inverted obligations.

### 4.4 The vocabulary is not the brief's vocabulary, and the difference is load-bearing

The brief's keyword list has 13 tokens. The tool's `NORMATIVE_TERMS` has 11. Missing:
`NOT REQUIRED` (191 probe sentences) and `MAY NOT` (357).

- `MAY NOT`: no phrase alternative exists, so `MAY NOT` matches as `MAY` → `polarity: positive`
  (25 requirement rows, above).
- `NOT REQUIRED`: `REQUIRED` matches inside it → `REQUIRED`/`absolute`/`positive`, or the
  sentence's _other_ upper keyword becomes `term` while the `REQUIRED` lands in `keywords[]`.
  21 of the 191 are covered by a row whose `term` is `MAY`, 7 `MUST`, 3 `SHOULD`, 2 `REQUIRED`.
- Mixed spellings that are neither upper, lower nor Title-Case are classified `keyword_case:
"upper"` by the **fallthrough** branch, and the candidate filter
  `entry.keyword_case !== "upper" || reason !== null` then deletes them. 17 sentences in 14
  documents where _every_ keyword occurrence in the sentence is such a spelling. Five of them —
  four distinct wordings — are in no channel at all:

| document / section             | sentence                                                                                       | spelling          |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------- |
| RFC 2178 §10.7, RFC 2328 §10.7 | "These LSAs should NOT be placed on the Link state retransmission list for the neighbor."      | `should NOT`      |
| RFC 9696 §5.14                 | "A node must NOT originate LIEs on an AF if it does not process received LIEs on that family." | `must NOT`        |
| RFC 4120 §5.3                  | "It is NOT recommended that this time value be used to adjust the workstation's clock, …"      | `NOT recommended` |
| RFC 2300 §6.9                  | "All Historic protocols have Not Recommended status."                                          | `Not Recommended` |

RFC 2178 §10.7 is worth one line on its own: the block's other two sentences **are** candidates,
this one is not. The section has **0 requirements and 0 mentions**. The most ordinary English
way to write a prohibition is the one spelling that is deleted. The other 12 of the 17 are not
deleted — they are matched by the strict pass on the single upper-case keyword and emitted with
`polarity: "positive"`, which is §4.3's problem, not this one's.

Any invariant has to state which vocabulary it means. "An RFC 2119/8174 keyword token" is not
well defined until `MAY NOT` and `NOT REQUIRED` are either in or out.

### 4.5 "For every section in the corpus" is the wrong quantifier, twice

1. **Section kind is not in the contract.** 656 uncovered sentences (61 % of all gaps) are in
   sections of kind `references` / `authors` / `index`, which both extractors skip by design. The
   loss _is_ counted — `blocks_skipped_by_kind: {"section:references": 84, …}` at document level,
   warning `candidate_sections_skipped:N` — but at section scope the caller gets a bare zero with
   no warning. Live: `read(1123, "7")` shows _"This section lists the primary references with which
   every implementer must be thoroughly familiar."_; `requirements(scope="7")` returns
   `total_requirements: 0`, `non_strict_candidates.total: 0`, and **no warning naming that
   section**. The invariant cannot hold for these sections as worded, and it should not: the
   right contract says "excluded by design, and here is the list", not "covered".
2. **The quantifier is per section, but the response is per document.** The 32 duplicate-text
   sentences (§2.2) are covered in one section and absent from another, so a section-keyed
   invariant is asserting something about a document-keyed API.

### 4.6 "Must survive pagination" — it does not, and the brief is right to ask

| channel                      | cap                                                                 | measured                                                                                            |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `requirements`               | default page **20** (`limits.applied.max_results: 20`), ceiling 200 | **85 of 182 documents** have > 20 requirement rows; max 995 (RFC 3261)                              |
| `requirements`               | cursor                                                              | paging to exhaustion is 50 calls for RFC 3261                                                       |
| `non_strict_candidates`      | 500 default / 2000 ceiling                                          | **0 documents exceed 500** (max 422) — latent, not active                                           |
| `non_strict_candidates` rows | **re-shipped on every page in the built server**                    | RFC 3261 page 1 = 357 rows, page 2 = **the same 357 rows** again; no `omitted_on_page` in the build |
| `mentions`                   | **500, silent**                                                     | 4 documents exceed it; RFC 3261 has 1 093, **593 withheld with no total, no cursor and no warning** |
| `read` `data.text`           | 16 384 bytes                                                        | 54 sections truncated; `offset_bytes` ignored for section reads                                     |

The _set_ a caller can reach does not change with paging, so the invariant survives pagination in
the set sense. Two things do not survive it:

- **the mention channel's cap is invisible and it is load-bearing.** `coverage` has no mention
  field at all (verified live: no key in `coverage` mentions mentions). 5 of the 101
  reached-and-classified gaps have their only row beyond the cap, which makes them **fully
  invisible**. The complete case, live:

  ```
  read(3261, "19.1.1")            →  "If the user string contains a telephone number formatted as a
                                      telephone-subscriber, the user parameter value "phone" SHOULD be present."
  requirements(scope="19.1.1")    →  12 rows, not it
  non_strict_candidates           →  8 rows, not it
  mentions                        →  500 returned, not it        (it is #769 of 1 093)
  men_be8a4b28e23779fa            →  term SHOULD  disposition "definition"  flags ["term_quoted"]
  coverage                        →  no mention field at all
  warnings                        →  nothing about it
  ```

  A sentence a caller can read is in no channel of the response that describes it, and no counter
  moves. This is the single most complete demonstration in the audit: it needs two independent
  defects (`term_quoted`, and the unannounced 500-row cap) to reach.

- **56 probes are covered only by a row the tool itself flags `continues_previous_block`** — the
  second half of a sentence a page break split. Those rows are shipped, and the flag is the honest
  description, but "covered" for them means "half of it is here".

### 4.7 The fragment tier: 14 % of all coverage is a fragment, and that is Y5 restated

3 224 probes (14.02 %) are covered only by a row that is a **strict sub-piece** of the sentence
the caller read — 14.7 % of everything the invariant calls covered. This is Y5's own complaint.
1 625 of them are in tier A, i.e. 13.3 % of tier A's covered mass: sentences with an upper-case
RFC 2119 keyword where `read` gives the caller the whole sentence and `requirements` gives a
fragment of it. The invariant is _satisfied_ by every one of them.

The mechanism is the splitter running on **blocks** while the caller reads **section text**: a
sentence that spans a page break is one sentence to the reader and two to the extractor. It is
not a bug in either half; it is the invariant measuring the wrong join.

---

## 5. Every uncovered sentence, by mechanism

1 080 uncovered sentences, **703 distinct**. Each was attributed by re-running the tool's own
`analyzeNormative` and `analyzeNormativeCandidates` on the single block that carries the keyword
and reading which branch dropped it — not by guessing from flags.

### A. Section kind skipped by both passes — 656 sentences, 438 distinct, 118 documents, 181 sections

`SKIPPED_SECTION_KINDS = {authors, index, references}`; the strict pass `continue`s on them, the
candidate pass counts them in `skippedSections`. Block kinds: `paragraph` 307, `reference_entry`
276, `list_item` 21, mixed 52. **No mention is produced, so there is no row anywhere.**

- RFC 1123 §7 (references, paragraph) — "This section lists the primary references with which every implementer must be thoroughly familiar."
- RFC 1350 §References (references, paragraph) — "Security Considerations Since TFTP includes no login or access control mechanisms, care must be taken in the rights granted to a TFTP server process so that…"
- RFC 7871 §7.2.1 (authors, 15 of 15 probes uncovered)
- RFC 7231 §Index — "1 1xx Informational (status code class) 50 2 2xx Successful (status code class) 51 3 3xx Redirection…" (a 30 kB index entry that the tool reads as one sentence)

### B. Fixed RFC Editor boilerplate excluded from the candidate pass — 146 sentences, 103 distinct, 102 documents, 124 sections

`isFixedBoilerplate` `continue`s before anything else. Block kind `paragraph` in 138 cases. The
sentences are IETF's own fixed notices, and the pass reports only a count
(`boilerplate_statements_excluded:N`) — never a sentence, never a mention.

- RFC 5780 §Status of This Memo — "Information about the current status of this document, any errata, and how to provide feedback on it may be obtained at http://www.rfc-editor.org/info/rfc5780."
- RFC 5689 §Copyright Notice — "The person(s) controlling the copyright in some of this material may not have granted the IETF Trust the right to allow modifications of such material…"
- RFC 4034 §1.1 (body) — "This document is part of a family of documents defining DNSSEC, which should be read together as a set."

### H. The block was never scanned and no mention exists — 144 sentences, 50 distinct, 105 documents, 122 sections

Two sub-populations, both verified by hand, and together they close the loop with §4.3:

- **H1 — the `keyword_case` fallthrough: 5 probe sentences, 4 distinct, 5 documents, 5
  sections.** The whole sentence is deleted by the candidate filter and the strict pass never
  matched it. Table in §4.4. An independent block-level scan of the same defect finds **17
  sentences in 14 documents**; the other **12** are not invisible — they are _covered_, by a
  strict row whose `polarity` contradicts the sentence (§4.3, P1). So the fallthrough produces
  5 invisible sentences and 12 wrong ones, and a coverage invariant scores both as fine.
- **H2 — page-furniture running heads and index/table text absorbed into a `paragraph` block:
  139 probe sentences, 46 distinct, 104 documents, 117 sections.** Block kinds: `paragraph` 95,
  `paragraph+reference_entry` 13, `paragraph+reference_entry+preformatted` 10,
  `paragraph+preformatted` 8, `paragraph+list_item` 5, `preformatted+paragraph` 4,
  `table+paragraph` 2, `reference_entry+paragraph` 2. RFC 1122 §5 (table+paragraph, 37
  overlapping blocks) and RFC 1123 §7 (table+paragraph, 11) produce probes such as "This
  specification, as amended by RFC-963, is intended to describe RFC1122 TRANSPORT LAYER -- TCP
  October 1989 the Internet Protocol but has some serious omissions…" and "[TELNET:5] "Telnet
  Suppress Go Ahead Option," J. Postel and J. RFC1123 SUPPORT SERVICES -- MANAGEMENT October 1989
  Reynolds, RFC-858, May 1983." — a running head spliced into the middle of a sentence, which is a
  parser symptom rather than a coverage decision, and which the strict pass also declines (so no
  mention). Top documents: RFC 9110 (14), RFC 2616 (8), RFC 9293 (7), RFC 2328 (5).
- RFC 9110 §Index contributes 14 of H2: index entries such as "1 2 3 4 5 A B C D E F G H I L M
  N O P R S T U V W X 1 100 Continue (status code) _*Section 15.2.1*_ 100-continue (expect value) …"

### D. `term_quoted`: the keyword is within 2 characters of a quote — 64 sentences, 59 distinct, 37 documents, 55 sections

Reached as a mention, `disposition: "definition"`, `flags: ["term_quoted"]`, and the flag is
wrong. Full account and live cases in §4.2. Block kinds: `paragraph` 50, `list_item` 4,
mixed 10.

### E. `keyword_enumeration`: ≥ 3 distinct keywords, or `META_DISCUSSION` — 37 sentences, 35 distinct, 25 documents, 37 sections

Reached as a mention, `disposition: "definition"`, `flags: ["keyword_enumeration"]`. Here the
decision is usually right (RFC 2181 §3: "This memo does not use the oft used expressions MUST,
SHOULD, MAY, or their negative forms." is _the_ conformance disclaimer and is not a requirement)
and sometimes wrong (RFC 1122 §3.3.3, "A host that does not implement local fragmentation MUST
ensure that the transport layer … obtains MMS_S …", has one distinct keyword and reached
`enumeration` only because `META_DISCUSSION` matches _"does not implement"_). Worst length:
RFC 8894 Appendix A — "Other changes include: * Resolved contradictions in the text — for example,
a requirement given as a MUST in one paragraph and a SHOULD in the next, …"

### C. `reference_entry` block — 28 sentences, 28 distinct, 17 documents, 20 sections

The candidate pass skips `block.kind === "reference_entry"`; the strict pass skips it as non-prose.
No mention. All 28 are `reference_entry` blocks, and RFC 8443 §1 is the worst: "As specified in
[RFC4412], the SIP 'Resource-Priority' header field may be used by SIP user agents (UAs) [RFC3261]
(including Public Switched Telephone Network…".

### G. Non-prose block, candidate pass emitted nothing — 3 sentences, 3 documents

RFC 6698 §10.1, a `preformatted` + `reference_entry` pair, both skipped for different reasons.
`keyword_bearing_blocks_skipped` counts such blocks at document level; the sentence is not named.

### No block covers the text — 2 sentences, 2 documents

RFC 2178 §References — "The following items must be configured for an area: Area ID This is a
32-bit number that identifies the area." The section's `text` contains caller-visible text that no
block covers, so no extractor can reach it. RFC 1812 §"Name Active Passive Description" — a
table-derived section number whose `text` includes "1 Exactly one instance of this attribute MUST
be present in packet." with **zero** overlapping blocks. `read` serves it; nothing indexes it.

---

## 6. Final table

| #     | mechanism                                                                                                                                                                                                                     | uncovered sentences (distinct) |      documents | worst example                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------------: | -------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | section kind `references`/`authors`/`index` skipped by both passes                                                                                                                                                            |                      656 (438) |            118 | RFC 1123 §7 — "This section lists the primary references with which every implementer must be thoroughly familiar." read shows it; `requirements(scope="7")` = 0 rows, 0 candidates, no warning               |
| B     | `isFixedBoilerplate` excludes the sentence from the candidate pass, strict pass makes no mention                                                                                                                              |                      146 (103) |            102 | RFC 5689 §Copyright Notice — "The person(s) controlling the copyright in some of this material may not have granted the IETF Trust…"                                                                          |
| H1    | every keyword match is a mixed-case spelling that `keyword_case` calls `upper`, so the candidate filter deletes it (block-level: 17 sentences / 14 documents — the other 12 are _covered_ with an inverted polarity, §4.3 P1) |                          5 (4) |              5 | RFC 2178 §10.7 / RFC 2328 §10.7 — "These LSAs should NOT be placed on the Link state retransmission list for the neighbor." block's other 2 sentences are candidates; §10.7 has 0 requirements and 0 mentions |
| H2    | page furniture / index text spliced into a `paragraph` block; both passes decline, no mention                                                                                                                                 |                       139 (46) |            104 | RFC 1122 §5 — "…intended to describe RFC1122 TRANSPORT LAYER -- TCP October 1989 the Internet Protocol but has some serious omissions…"                                                                       |
| D     | `term_quoted`: quote char within 2 chars of the keyword ⇒ `disposition: definition`, no requirement, candidate deletes it                                                                                                     |                        64 (59) |             37 | RFC 1123 §5.2.16 — "A host … MUST NOT interpret or modify the "local-part" of the address." `men_3a09eb8db576c96d`, strength absolute, polarity negative, **disposition definition**                          |
| E     | `keyword_enumeration` (≥ 3 distinct keywords, or `META_DISCUSSION` "does not implement") ⇒ mention only                                                                                                                       |                        37 (35) |             25 | RFC 1122 §3.3.3 — "A host that does not implement local fragmentation MUST ensure that the transport layer … obtains MMS_S …" one distinct keyword, flagged as enumeration                                    |
| C     | `reference_entry` block: skipped by the candidate pass, non-prose for the strict pass                                                                                                                                         |                        28 (28) |             17 | RFC 8443 §1 — "As specified in [RFC4412], the SIP 'Resource-Priority' header field may be used by SIP user agents (UAs)…"                                                                                     |
| G     | non-prose block where the candidate pass emitted nothing                                                                                                                                                                      |                          3 (3) |              3 | RFC 6698 §10.1 — `preformatted` + `reference_entry`, skipped for two different reasons                                                                                                                        |
| —     | no block in the document covers the text `read` returns                                                                                                                                                                       |                          2 (2) |              2 | RFC 1812 §"Name Active Passive Description" — "1 Exactly one instance of this attribute MUST be present in packet."                                                                                           |
| **Σ** |                                                                                                                                                                                                                               |                **1 080 (703)** | **150 of 182** |                                                                                                                                                                                                               |

Two mechanisms that are **not** coverage failures but are invisible to this invariant:

| #   | mechanism                                                                                                                                     |                                       count | documents | worst example                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------: | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | requirement row's `polarity` contradicts its own sentence (`<UPPER> not`, `MAY NOT`)                                                          | 16 primary-keyword rows / 25 `MAY NOT` rows |    9 / 18 | RFC 3261 `req_76dcffb7c47de7e6` — "A registrar MUST not generate 6xx responses." → `term MUST`, `strength absolute`, **`polarity positive`**, `confidence 0.9`, `flags []` |
| P2  | keyword-free normative prose; `analyzeDeclarativeSpecifications` exists in `src/`, is absent from `dist/`, and the service does not expose it |                                  1 286 rows |       134 | RFC 788 §4.5.3 — "The maximum total length of a user name is 64 characters." (`numeric-bound`)                                                                             |

---

## 7. Is the invariant the right contract? No — and here is the wording I would defend

The shape is right: a conservation law over a partition of the caller's text, checked label-free,
in `eval/run-bench.mjs`. Four things are wrong with it.

1. **"Cover" is undefined where it matters.** It has to distinguish _reached as a statement_,
   _reached and classified as not-a-statement_, and _not reached_. Only the first is coverage.
2. **It is blind to fidelity.** It is passed by 16 rows that invert their own sentence. A
   conservation law over _reaches_ says nothing about whether the reach is true; a contract that
   only counts reaches will be green while shipping inverted obligations.
3. **It quantifies over the wrong set.** "Every section in the corpus" includes sections excluded
   by design, and asserts per-section coverage of an API that answers per document.
4. **Its subject is not a well-defined string.** Three renderings, two coordinate systems, a
   16 KB default truncation, and a `keyword` notion that differs between the brief (13 tokens) and
   the tool (11), with `MAY NOT` and `NOT REQUIRED` doing real damage in the difference.

The wording I would put in `eval/run-bench.mjs` instead, as three separate label-free invariants
over a pinned snapshot set:

> **R1 — reach.** For every sentence S of the caller-visible rendering of a section that contains
> an RFC 2119/8174 keyword token in any capitalisation, exactly one of the following holds, and
> the response names which:
> (a) S is the `exact_text` of a row in `requirements`, `non_strict_candidates.candidates`, or
> `non_strict_candidates.fragments`, attributed to S's own section and present on the page
> the caller is holding; or
> (b) S is the `exact_text` of a row in `mentions` whose `disposition` and `flags` state the
> reason it is not normative, attributed to S's own section and present on the page the
> caller is holding; or
> (c) S appears in a per-section `not_classified` list on the response, one entry per sentence,
> each with a reason from a closed vocabulary (`section_kind_excluded`,
> `non_prose_block`, `reference_entry`, `fixed_boilerplate`, `quoted_terminal`,
> `keyword_enumeration`, `outside_candidate_budget`, `no_block_covers_text`) and a
> `citation_id`.
> No sentence may satisfy none of (a), (b), (c). Every (b) and (c) sentence must be counted in
> `coverage` under its own name, never inside `total_requirements`.
>
> **R2 — fidelity.** For every row in `requirements`, the `strength`/`polarity` pair asserted for
> the primary keyword must agree with the keyword as written in `exact_text`, after
> whitespace normalisation and case folding of the phrase. A sentence containing `MAY NOT`, or an
> upper-case keyword followed by a lower-case `not`, must never yield `polarity: "positive"`. A
> row that cannot make them agree must carry a flag naming the disagreement. Measured today: 16
> rows in 9 documents fail R2 on `<UPPER> not` and 25 rows in 18 documents on `MAY NOT`.
>
> **R3 — conservation of the budget.** Paging a document to exhaustion must yield the same set of
> `requirements` rows, the same set of candidate rows and the same set of mentions as one
> unpaged call with the ceilings raised, and every channel that truncates must report its own
> `returned` / `total` and set `truncated: true`. Measured today: `mentions` has no total and no
> truncation flag; 4 documents exceed 500; the built server re-ships all 357 candidate rows of
> RFC 3261 on every page.

Two preconditions that are not invariants but must be fixed before any of the three is
measurable, because a checker cannot be written against them as they stand:

- one rendering. `data.text` and `text_verbatim` differ in length for 2 877 sections and the
  response does not say the offsets diverge; `read` truncates 54 sections at 16 384 bytes and
  ignores `offset_bytes` for a section. Until `read` returns one text whose offsets denote its own
  bytes, "the section's `text`" is three strings and R1 is not a well-formed statement.
- one vocabulary. Either `MAY NOT` and `NOT REQUIRED` join `NORMATIVE_TERMS` with an explicit
  reading, or the checker states that they are out of vocabulary and the polarity of a row whose
  sentence contains them is not trusted. 191 and 357 sentences respectively turn on this.

What I would **not** change: the per-section accounting idea, the requirement that the check be
label-free and run over the whole corpus, and the fact that it belongs in `run-bench.mjs` next to
the other invariants. The instinct behind Y5 — _a caller who reads a section and then asks for
its requirements must not get less than they just read_ — is correct and is not what the sentence
in pending-fixes.md says. As written it is a sentence about set containment; what is needed is a
sentence about what the caller can learn, and R1 is that sentence.

---

## 8. Reproduction, and what this audit could not settle

- Read-only throughout: one `DatabaseSync(path, {readOnly:true})`, one transaction, no ingest, no
  re-analysis, no build, no write to the database. The only file written is this one.
- Corpus-scale, not sampled: all 182 documents, all 9 955 sections, all 22 990 keyword-bearing
  sentences. Sampling cannot falsify a universal claim and none was used.
- The strict and candidate extractors were loaded from `dist/analysis/normative.js` — the build the
  live `tools.rfc.*` server actually runs — so the numbers are the caller-visible state. The
  `src/` tree was loaded separately (Node type-stripping, with `core/util.ts` and `core/types.ts`
  stubbed for their two runtime values) only to measure the unbuilt `declarative` channel, which
  is reported as latent.
- `read --section` and `requirements` were spot-verified live for every mechanism in the table
  (RFC 1123, 1812, 2119, 2178, 2865, 3261, 4271, 791), including the response-field inventory in
  §1.4. The corpus moved from 159 to 182 documents during the audit, so the live spot checks were
  re-run against the final generation; every quoted response is from generation 1981 or later.
- Two harness defects of my own were found and fixed mid-audit, and both are worth recording
  because they would have produced plausible wrong numbers: (i) an offset map that mis-aligned
  after the first blanked furniture line, which invented ~5 600 phantom gaps until the store's
  coordinates were verified end-to-end (§1.2); (ii) resolving a document by `rfc` rather than by
  `snapshot_id`, which silently mixed snapshots while the corpus was being re-ingested. Any
  re-run must key on `snapshot_id` and must verify the block↔section offset invariant before
  trusting a position-based coverage test.
- Not settled: whether the 32 duplicate-text sentences in unrelated sections are a scoping defect
  or the correct consequence of a document-keyed API (I lean towards the latter, and the contract
  should say which); and whether `isFixedBoilerplate` should apply to IETF's own notices at all
  (if it should not, 146 sentences change bucket, and if it should, they need a row somewhere).

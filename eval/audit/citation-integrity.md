# Citation integrity audit — adversarial pass

Scope: the three claims about `Requirement` / `NormativeCandidate` spans, `verify_citation`
verdicts, and `scit_` stability. Read-only. No source, corpus or build was modified.

**Corpus state at time of audit.** The corpus is being written by another process while this
audit runs: `index_generation` moved 1953 → 1979 and the snapshot count 159 → 181 during the
session. Every figure below is labelled with the generation or the row population it was taken
at, and every rate is expressed as a fraction of the population actually tested, so the rates
hold regardless of the drift.

**Two facts about the artefact under audit, established first, because they bound everything
else.**

1. `scit_`, `verifyStableCitation`, `stable_citation_id` and `CitationVerdict.citation_id_kind`
   are **uncommitted, unbuilt and unmigrated**. `git status` shows `src/analysis/citation.ts`,
   `src/analysis/normative.ts`, `src/service/rfcService.ts`, `src/store/database.ts`,
   `src/store/schema.ts` modified. `dist/analysis/citation.js` (mtime 12:31) contains zero
   occurrences of `scit_`; `src/analysis/citation.ts` was written at 12:51. The corpus is at
   `schema_version = 7`; migration 8 (`src/store/schema.ts:16-38`) is the thing that would add
   `stable_citation_id`, and it has not been applied: `PRAGMA table_info(requirements)` returns
   no such column.
2. Consequently **no running binary can execute the `scit_` path at all**, and this is
   demonstrable rather than inferred. `verifyStableCitation` calls `stableCitationOrigins`
   (`src/service/rfcService.ts:2083`) before anything else, and that method's first statement is
   `SELECT DISTINCT snapshot_id FROM requirements WHERE stable_citation_id = ? …`
   (`src/store/database.ts:1166-1168`). Run against the shipped corpus it raises:

   ```
   Error: no such column: stable_citation_id
   ```

   Every `scit_` verification against this corpus throws rather than returning a verdict. The
   tool confirms the symptom: `verify_citation({citation_id:"scit_000000000000000000000000",
rfc:1812, section:"4.2.2.11"})` returns `verdict: "not_found"`, `notes: ["no stored record
matches the supplied locator or quote hash"]` — the pre-change code path, which treats an
   `scit_` id as an ordinary `cit_` id and finds nothing.

So claims 2 and 3 are split: the `cit_` half of claim 2 was tested against the running server,
and the `scit_` half was tested against source plus a byte-exact reimplementation of the pure
function, and is otherwise **untestable in this repo state**. That is itself a finding and it is
recorded as such rather than papered over.

---

## A. Offset audit at scale

### A.1 `Requirement` rows — 12 209 / 12 209 exact, in all three units

Every stored `requirements` row was checked, not sampled. For each row the snapshot's `raw`
blob was decoded exactly as the parser does it (`new TextDecoder("utf-8",{ignoreBOM:true})`)
and three independent slices were compared against `exact_text`: by `char_start/char_end`, by
`byte_start/byte_end` on the raw buffer, and by `codepoint_start/codepoint_end` on
`Array.from(text)`.

| check                                                                          | result (of 12 209) |
| ------------------------------------------------------------------------------ | ------------------ |
| `text.slice(char_start, char_end) === exact_text`                              | 12 209 / 12 209    |
| `raw.subarray(byte_start, byte_end) === exact_text`                            | 12 209 / 12 209    |
| `Array.from(text).slice(codepoint_start, codepoint_end) === exact_text`        | 12 209 / 12 209    |
| `char_end - char_start === exact_text.length`                                  | 12 209 / 12 209    |
| `byte_end - byte_start === utf8len(exact_text)`                                | 12 209 / 12 209    |
| `codepoint_end - codepoint_start === cplen(exact_text)`                        | 12 209 / 12 209    |
| `line_start/line_end` bracket the lines the text occupies                      | 12 209 / 12 209    |
| declared byte offset == byte offset recomputed independently from `char_start` | 12 209 / 12 209    |

Also clean: `sections` 9 312 / 9 312 and `blocks` 64 103 / 64 103 in all three units. A
479-row stratified sample drawn first (125 documents, deliberately including the five pre-1990
typeset RFCs 768/791/792/793/854, table-heavy documents, CDDL documents such as RFC 9472,
every non-ASCII document, and RFC 8949) also returned zero findings, so the full pass is a
confirmation and not a surprise.

Coverage by the classes the task named: pre-1990 typeset documents present and clean (RFC 768
rows: 4 requirements, 4 mentions, all exact); table-bearing documents clean (RFC 5322, 3261,
4868); CDDL/ABNF documents clean (RFC 9472, 4251, 7595). **No ISO-8859 or invalid-UTF-8
document exists in this corpus** — all 181 snapshots re-encode byte-identically and none
contains U+FFFD, so the `byte_offsets_approximate_invalid_utf8` branch
(`src/parse/text.ts:124-127`) and the `decodedText` fallback at
`src/service/rfcService.ts:2375-2382` are unexercised here and were not testable.

### A.2 The inverse check — the span is not always the first occurrence

Of the 479 sampled rows with text ≥ 25 chars, 10 texts occur more than once in their document.
For 8 of those 10 the declared span is **not** the first occurrence. Examples (generation 1953):

```
req_005fce6aa363ebf9 rfc9110  declared char_start 189309, first occurrence 186548
req_0749c94d8e28c8b8 rfc4034  declared char_start  39052, first occurrence  24954
   "The Key Tag field MUST be represented as an unsigned decimal integer."
req_1439c682943c8219 rfc2845  declared char_start  20793, first occurrence  19693
   "The server SHOULD log the error."
req_36e07c3c0b2b84eb rfc8447  declared char_start  31829, first occurrence  17647
```

This is not a defect: the span is exact for the row it belongs to, and the row is the later
occurrence. It does mean **`exact_text` plus a document, without the span, does not identify a
citation** — the RFC 2845 sentence is a two-place text and both places are stored requirements
(§4, chars 19693 and 20793). That fact is what makes claim 2's `ambiguous` verdict load-bearing,
and it is examined in section C.

### A.3 `NormativeCandidate` rows — 0 / 2 211 exact. Total failure.

2 211 candidate rows were pulled through the shipped tool (`requirements` with
`include_candidates: true`, `max_candidates: 200`, batched 10 documents at a time) across 30
documents including RFC 1122, 8949 (the only astral document), 5322, 9472, 9110, 768, 791, 792,
793, 854, 1035. Each row's declared span was sliced out of the snapshot bytes.

| check                                              | result (of 2 211)                                  |
| -------------------------------------------------- | -------------------------------------------------- |
| `span` slice `=== exact_text`                      | **0 / 2 211**                                      |
| `byte_start..byte_end` slice `=== exact_text`      | **0 / 2 211**                                      |
| span slice is exactly the RFC 2119 keyword         | 57 / 2 211 (the rest are keyword-internal offsets) |
| span narrower than `exact_text`                    | 2 211 / 2 211                                      |
| `exact_text` present **somewhere** in the document | 2 211 / 2 211                                      |
| `exact_text` present at the declared `char_start`  | 16 / 2 211                                         |
| span carries `codepoint_start` / `codepoint_end`   | **0 / 2 211**                                      |
| `line_start/line_end` consistent                   | 2 211 / 2 211                                      |

Worked example, verbatim from the response:

```json
{
  "id": "cnd_8b5406602c0898b2",
  "rfc": 1122,
  "section": "2.3.3",
  "span": {
    "byte_start": 60620,
    "byte_end": 60624,
    "char_start": 60620,
    "char_end": 60624,
    "line_start": 1399,
    "line_end": 1400
  },
  "char_start": 60620,
  "exact_text": "o    MUST be able to send and receive packets using RFC-894\n              encapsulation;"
}
```

The declared span is 4 characters wide and holds `"MUST"`. `exact_text` is 88 characters and
lives at char 60615. `char_start` at the top level is the keyword offset too. **There is no
field anywhere on a candidate row that addresses its own `exact_text`** — not `span`, not
`char_start`, not `keywords[].char_start`.

Cause, `src/analysis/normative.ts:1469-1477`: `span` is built from `charStart`/`charEnd`, which
are the **keyword's** offsets (`normative.ts:1439`), while `exact_text` is `sentence.text`
(`normative.ts:1466`). The type makes this visible and unremarked —
`src/core/types.ts:400` declares the candidate span as
`Pick<Span, "byte_start"|"byte_end"|"char_start"|"char_end"|"line_start"|"line_end">`, so
`codepoint_*` is **omitted from the candidate span entirely**. Claim 1 asserts candidate spans
carry code-point offsets; the type says they cannot.

This is the exact defect the sibling row type was explicitly fixed for. `src/analysis/normative.ts:1261-1264`,
on the `Requirement` path:

> The span is the STATEMENT, not one keyword inside it. A caller anchoring a contract line to this
> row quotes the sentence, so the citation has to verify the sentence; a span that covered four
> letters of it verified nothing about what the contract would say.

The candidate path carries the span the comment rejects. The same shape appears on the mention
path (`normative.ts:1160-1183`): 13 747 mention rows, **0 of 13 747** have a span that holds
`exact_text`; every one holds the keyword while `exact_text` is the sentence; the `exact_text` is
present at the declared `char_start` for 26 rows out of 12 358 at generation 1953. `NormativeMention`
even declares the full eight-field span including `codepoint_*`
(`src/core/types.ts:252-262`), so a mention row advertises code-point offsets for a span that
addresses four letters of a different string.

One row type in this codebase holds its span, two do not, and nothing in the type, the schema or
the tool description says which is which.

### A.4 The citation id on the broken rows mixes the two strings

`mention.citation_id` is `citationId({snapshotId, blockId, byteStart: charStart, quote})` where
`charStart` is the **keyword** offset and `quote` is the **sentence** (`normative.ts:1188-1193`).
Recomputed for all mention rows at generation 1953: 12 358 / 12 358 reproduce from
`(char_start, exact_text)` and 0 / 12 358 from anything else. So a mention's citation id is a
hash of _the keyword's position_ and _the sentence's text_ — the id identifies a place, and the
text at that place is four letters long, while the row's `exact_text` is the whole sentence.
`mention.id` uses the same offset with `quote: match[0]`, i.e. keyword-against-keyword.

By contrast `requirements.citation_id` reproduces from `(char_start, exact_text)` for
10 966 / 10 966 rows — the offset and the text agree.

---

## B. Code-point audit — the claim survives, and I could not break it

`codepoint_start` / `codepoint_end` are real code-point offsets, not byte offsets relabelled.

For all 12 209 requirement rows I recomputed, from `char_start` alone and with an independent
one-pass prefix table, the true byte offset and the true code-point offset, then compared both
against what the row declares:

| check                                                               | result          |
| ------------------------------------------------------------------- | --------------- |
| declared `byte_start/end` == independent byte offset                | 12 209 / 12 209 |
| declared `codepoint_start/end` == independent **code-point** offset | 12 209 / 12 209 |
| declared code-point == declared byte **where the two must differ**  | **0**           |
| declared `char_start` == declared `byte_start`                      | 9 247 / 12 209  |
| declared `char_start` != declared `byte_start`                      | 2 962 / 12 209  |
| declared `char_start` != declared `codepoint_start`                 | 0 / 12 209      |

The 2 962 divergent rows are exactly the rows in the 43 BOM documents where non-ASCII precedes
them. Worked example, RFC 8659 (BOM + `é` in the author block):

```
req_94cb22082987173c  char [5233,5311]  byte [5235,5313]  codepoint [5233,5311]   divergence 2
req_54abd324649ba7f7  char [5316,5424]  byte [5318,5426]  codepoint [5316,5424]   divergence 2
req_cdc693b8e0e62439  char [8516,8611]  byte [8518,8613]  codepoint [8516,8611]   divergence 2
```

Three units, three different numbers where they should differ, correct in all three. The
returned span from a live `verify_citation` on RFC 9110 (BOM + `é`, `ø`, `ñ`) shows the same:
`char_start 355815, codepoint_start 355815, byte_start 355817` on the candidate row, and
`char_start 23141, codepoint_start 23141, byte_start 23143` on a stored mention. The char/byte
divergence is carried correctly through the service.

The engine is `mapCharOffsets` (`src/core/util.ts:155-177`), which advances a cursor by 2 UTF-16
units and 1 code point for `cp > 0xffff`, and 1 unit for `cp <= 0xffff` — the right rule, and
the 4-byte branch is exercised: 118 block rows and 8 section rows have `char != codepoint`, all
in RFC 8949, the corpus's only astral document (one astral code point, U+10151, at char 135141).

Two limits worth recording, neither a defect:

- **No stored span lands inside a surrogate pair.** Checked `char_start` and `char_end` for all
  requirements, mentions, blocks and sections: 0 cases where the preceding unit is a high
  surrogate and the following a low surrogate. The known failure mode of `mapCharOffsets` (a
  target landing mid-pair makes the byte count overshoot by the full 4-byte width) is
  unreachable from the current span producers. It would be reachable from a _caller_ who passes
  a hand-computed `char_start` into a `mapCharOffsets`-style path; no such path is exposed.
- **The astral branch is unexercised on the requirement and mention paths.** RFC 8949's single
  astral code point is at char 135141; its requirements span chars 19 276–116 660, all _before_
  it. So the 4-byte branch is proven for blocks and sections and untested for the row types under
  audit. The corpus cannot settle it either way.

**One hard-coded exception, disclosed.** On the `scit_` path the returned citation span carries
`codepoint_start: 0, codepoint_end: 0` (`src/service/rfcService.ts:2193-2194`), with the comment
"nothing records the code-point offset of a sentence inside a block". `CHANGELOG.md:79-80`
discloses it. A caller that slices a stable citation by code point gets the first code points of
the document and no error. Disclosed is not the same as safe, but it is not a hidden defect and
I am scoring it accordingly.

---

## C. `verify_citation` red team

Five verdicts, five verdicts tested. What I got, and what I needed.

### C.1 `verified` — reachable, and it does **not** mean what claim 2 says

Reachable trivially: any requirement citation in the corpus. But the guarantee as written —
"`verified` only when the bytes it checked are the bytes the row came from" — is **false**, and
the falsification is total rather than marginal.

`src/service/rfcService.ts:2369-2374` verifies with:

```ts
const slice = raw.subarray(block.byte_start, block.byte_end).toString("utf8");
if (slice.includes(match.exact_text)) { verdict = "verified"; … }
```

Three separate facts follow:

1. **The row's span is never consulted.** The check runs over the _block's_ byte range, and
   `includes` — not equality. A row whose declared span points at entirely the wrong bytes still
   verifies, provided the text occurs somewhere in its block.
2. **The `locator.span` returned to the caller is the block's span**, not the row's and not the
   quote's. `src/service/rfcService.ts:2409-2418` fills the span from `block?.byte_start`,
   `block?.char_start` and so on; `match.char_start`, which _is_ the row's own offset and is
   selected by the query at `src/store/database.ts:1266`, is discarded.
3. Therefore **`verified` does not attest that any span in the response addresses the quote.**

Demonstrated on a stored mention, live:

```
row men_23189b20c839ab2f  (RFC 9110, term MUST NOT)
  declared span : char 23153..23161  (8 chars, the keyword)
  exact_text    : 118 chars, "A sender MUST NOT generate protocol elements that do not match
                  the\n   grammar defined by the corresponding ABNF rules."
verify_citation(cit_…) ->
  verdict       : "verified"
  notes         : ["quote matches bytes 23143..23501 (lines 572..577)"]
  returned span : char 23141..23499  -> 358 chars wide
  returned quote: 118 chars
  span == quote : false
```

The verdict is `verified`, the returned span is 358 characters wide, the quote is 118, and the
row's own 8-character span appears nowhere in the response. Slicing the returned span does not
produce the quote; it produces the quote plus 240 characters of neighbouring text. A caller who
persists `locator.span` alongside `quote` — which is the natural thing to do, and what the
`verified` verdict invites — persists a pair that does not reproduce.

The same holds on the candidate path, where the fallback
`findBlockByDerivedCitation` (`src/service/rfcService.ts:1989-2021`) reconstructs the row by
brute force: it walks every block in the snapshot, splits each into sentences, and hashes the id
once per whitespace-delimited token so the comparison can land on the keyword's offset. Live
result on `cnd_8b5406602c0898b2`: `verified`, returned span 97 chars, quote 88 chars, row span
4 chars.

I looked for a way to make `verified` fire on text that is nowhere near the row, and did not
need to: **every** mention row (13 747) and **every** candidate row (2 211 audited) already
carries a span that does not address its text, and all of them verify.

### C.2 `stale` — unreachable on the `cit_` path; the "different derivation" case returns `not_found`

I built the case the claim describes. All 23 324 stored citations at generation 1953 (10 966
requirements + 12 358 mentions) were re-checked exactly as `verifyCitation` checks them — the
quote's presence in its own block's bytes:

```
23 324 / 23 324  would be "verified"
     0 / 23 324  would be "stale"
```

`stale` cannot be produced on the `cit_` path by anything a caller can do. It requires a stored
`exact_text` that is absent from its own block — i.e. a mutated row. Two independent reasons:

- The parse and the store are the same code. A `Requirement` span is exact by A.1, and a
  `Mention` span is keyword-exact, so the quote is inside the block by construction.
- The lookup is **snapshot-scoped** (`WHERE snapshot_id = ? AND citation_id = ?`,
  `src/store/database.ts:1266`). `cit_` is a hash of the snapshot id, and the snapshot id embeds
  `parserVersion` and `extractorVersion` (`src/service/rfcService.ts:489`). A citation minted
  under one derivation therefore **cannot be found under another** — the lookup misses, `matches`
  is empty, and the verdict is `not_found` at `src/service/rfcService.ts:2351-2353`. This is the
  behaviour `src/analysis/citation.ts:11-14` describes from the other side ("`verify_citation`
  answered `not_found`"). It is the opposite of what claim 2 says `stale` is for.

`stale` **is** reachable on the `scit_` path, and reachable by design: `src/service/rfcService.ts:2222-2237`
returns it when the sentence is found in the pinned snapshot but no row there carries the id. I
could not execute that branch (§ preamble). Untested.

### C.3 `ambiguous` — reachable, but it does not mean "the text stands more than once"

The case the task names, RFC 2865 §5.11 / §5.18, **cannot produce `ambiguous`, for two
independent reasons.**

First, the sentence does not occur twice as written. In the corpus copy of RFC 2865 the fragment
"It is intended to be human readable and MUST NOT affect operation of the protocol." occurs
**three** times, at chars 76899, 84749 and 88251, and the three are not identical — the middle
one reads "human readable,\n and MUST NOT affect". A search for the exact one-line sentence
returns 0 hits.

Second, and decisively, the three sit in different attribute sections (5.11 Filter-Id, 5.18
Reply-Message and a third). `scit_` hashes the section number, so the three mint three
different ids. **`ambiguous` is structurally confined to duplicates inside one section** — which
is correct behaviour, and which the named test case does not exercise.

Genuine single-section duplicates do exist, and are the right test:

```
rfc1812 §4.2.2.11  x2  "It MUST NOT be used as a source address."   chars 120047, 120410
rfc2845 §4         x2  "The server SHOULD log the error."            chars  19693,  20793
```

I walked the whole `cit_` space for a false positive and found one, then watched it get defused.
20 `cit_` ids exist in **both** `requirements` and `mentions` for the same snapshot (20 at
generation 1979) — always a sentence that begins with its keyword, so the requirement's
sentence-start equals the mention's keyword-start and both hash the same sentence:

```
cit_e58a597f26e1d45d8f2ad074  rfc6648
  requirement req_e58a597f26e1d45d8f  char_start 7928  char_end 8084  (the sentence)
  mention     men_0d26ac5a1d2264f1  char_start 7928  char_end 7934  (the keyword)
  the text stands in exactly 1 place in the document
```

`findCitationMatches` appends rows from both tables, so this would be 2 matches and the verdict
would be `ambiguous` — a false ambiguity on a citation that stands once. It is not, because
`src/store/database.ts:1352-1357` drops a mention whose `citation_id` a requirement also carries.
Confirmed live: `cit_e58a597f26e1d45d8f2ad074` and `cit_c937c8d096919c40869fc046` both return
`verified` with one match. The dedupe is unchanged in the working tree. **I could not construct a
false `ambiguous` on the `cit_` path.** Reporting that as a refuted hypothesis, not a finding.

`ambiguous` is nonetheless overloaded, and demonstrably so. Passing two locators that disagree —
a `citation_id` for one sentence plus a `quote_sha256` for a different one — returns:

```
verdict : "ambiguous"
matches : 3   (2 distinct texts, one of them twice)
notes   : ["3 stored records match; a locator is required to disambiguate"]
```

Neither named text stands more than once. `findCitationMatches` treats its locator arguments as
disjunctive (`if (input.citationId) … if (input.quoteSha256) …`, `src/store/database.ts:1263-1314`),
so a caller who passes a belt-and-braces pair of locators is told the citation is ambiguous
because the server holds two views, not because the evidence is two-valued. Claim 2's
"`ambiguous` when the text stands more than once" does not describe this branch.

### C.4 `not_found` — reachable, and the note cannot distinguish three different failures

Reachable, and confirmed for a deliberately corrupted id, a well-formed-but-absent id, and a
non-id string:

```
verify_citation({citation_id:"cit_3fe0a4fb12e8fc9dc08541e", rfc:1122})
  -> verdict "not_found", notes ["no stored record matches the supplied locator or quote hash"]
verify_citation({citation_id:"not-an-id", rfc:1122})
  -> verdict "not_found", notes ["no stored record matches the supplied locator or quote hash"]
```

Byte-identical responses for a truncated hex id, a valid id that does not exist, and a string
that is not an id at all. A caller cannot tell "you sent me nonsense" from "this text was
amended" from "you pinned the wrong snapshot". The working-tree build narrows this — it echoes
`citation_id` and adds `citation_id_kind`, so `unrecognized` becomes visible — but all three
still produce the same note and the same empty `matches`.

### C.5 `integrity_failure` — reachable only by corrupting the database; a citation is never examined

Not reachable by any tool input, and I looked for the lever.

`raw_sha256` and `raw` are written from one value. `src/service/rfcService.ts:480` computes
`const rawSha256 = sha256Hex(publication.body)`, and `:552` stores `raw: publication.body` — the
same `Buffer`. The single `INSERT INTO snapshots` (`src/store/database.ts:532-556`) writes both
from that bundle. `getSnapshotRaw` (`src/store/database.ts:819-822`) returns
`Buffer.from(row.raw)`, a faithful copy. So `sha256Hex(raw) === snapshot.raw_sha256` holds by
construction, and it holds in the corpus today: **181 / 181 snapshots hash to their recorded
`raw_sha256`, 0 mismatches, 0 with a NULL or empty `raw` or `raw_sha256`.**

The verdict fires on exactly one condition — on-disk divergence between the blob and its
recorded hash — and the citation is never looked at when it does. So: the verdict is real, the
code is correct, and it is a property of the store rather than a verdict about a citation. A
caller cannot obtain it, and cannot use it to learn that a citation went bad.

### C.6 The cost of the candidate path

Not one of the three claims, but it is the reason the candidate citation is unusable in bulk and
it belongs with the citation findings. `findBlockByDerivedCitation` hashes
`citationId(snapshot, block, offset, sentence)` once per whitespace token of every sentence of
every block in the snapshot. Measured wall-clock for a **single** `verify_citation` on a
candidate id:

| document                       | one verification                    |
| ------------------------------ | ----------------------------------- |
| RFC 9110 (355 000 chars)       | 2048 ms, then 7357 ms, then 1080 ms |
| RFC 793 (180 provisional rows) | 2478 ms                             |
| RFC 791 (81 provisional rows)  | 847 ms                              |
| RFC 792 (65 provisional rows)  | 324 ms                              |
| RFC 768 (4 provisional rows)   | 273 ms                              |

`include_provisional` is advertised as "the only way to get a compliance list" for a document
predating RFC 2119 (`src/mcp/tools.ts:146-148`), and every one of those rows returns a
candidate-style citation, so verifying RFC 793's list of 180 is on the order of minutes of
single-threaded SHA-256. The variation (1080–7357 ms for the same call shape on the same
document) means there is no cache and no bound a caller can plan around.

---

## D. Stability of `scit_`

`scit_` is unbuilt and unmigrated, so this was tested by reimplementing `stableCitationId`
byte-exactly from `src/analysis/citation.ts:82-92` and minting ids the way the store does
(`src/store/database.ts:1731-1740`) against the live corpus. That reimplementation is exact:
`scit_` = `shortHash(\`rfc${rfc}|${sectionNumber}|${sha256Hex(quote).slice(0,32)}|${occurrence}\`)`,
`sha256Hex`and`shortHash`per`src/core/util.ts:8-14`.

### D.1 What it is genuinely invariant to — confirmed

The formula takes no `snapshot_id`, no `block_id`, no byte offset, no char offset, no line
number, no `parser_version`, no `extractor_version`, no `codepoint_*`. I minted ids for a
requirement row, then re-minted with each of those inputs replaced by a garbage value; the id is
unchanged in every case, by construction rather than by test. That part of the design is sound,
and the `cit_` problem it addresses is real: `cit_` hashes the snapshot id, and the snapshot id
embeds the parser and extractor versions (`src/service/rfcService.ts:489`), so **any** version
bump changes **every** `cit_` id in the corpus. The rationale is correct.

It also does change when the task requires: different RFC number, different section number,
different quote, different occurrence — all four are in the hash and I confirmed each one flips
the id. No collision is constructible from those four inputs short of a sha-256 prefix collision
in 96 bits.

### D.2 The occurrence index is constant, so two obligations in one section share one id

`src/store/database.ts:1738` mints every stored id as
`stableCitationId({rfc, sectionNumber, quote: row.exact_text})` — `occurrence` is never passed, so
it is always `0`. `src/analysis/citation.ts:75-81` justifies this: "`0` and `1` are two ids for
two places … it changes nothing about verification … but it lets a caller that DID count keep
the two apart in its own records." A caller cannot count: the server never does, and
`stableCitationOrigins` reads the column rather than counting. The occurrence input is inert in
the write path.

Consequence, measured on the live corpus with the store's exact formula:

```
requirements: 10 966 rows -> 10 955 distinct scit_ ids; 10 ids carried by 2 rows each
   scit_8b47c2b75734006fc7708fbe  rfc1812 §4.2.2.11  blk_4fd8e0331adc07a8  char 120047
   scit_8b47c2b75734006fc7708fbe  rfc1812 §4.2.2.11  blk_8c6d94879d66bd6f  char 120410
        both: "It MUST NOT be used as a source address."
   scit_340e57e6a29a46f4c8516e72  rfc2845 §4         two blocks, chars 19693 and 20793
        both: "The server SHOULD log the error."

mentions: 12 358 rows -> 11 075 distinct scit_ ids; 1 125 ids carried by >1 row
   scit_7dd63a9a9c83cbd8c15234da  x4  rfc1122, one sentence, four keyword occurrences
        "An implementation that satisfies all the MUST and all the SHOULD requirements for
         its particular protocol..."

12 101 mention ids are also minted by a requirement — one sentence, two rows, one id.
```

The requirement collisions are the serious ones: **two distinct blocks, two distinct places, one
citation id.** They are handled — `verifyStableCitation` groups by text hash and returns
`ambiguous` with both spans (`src/service/rfcService.ts:2204-2208`) — but only because the
resolution is by sentence and the collision is by row. A caller that stores `stable_citation_id`
as the handle for "this obligation", which is the entire stated purpose
(`src/store/schema.ts:363-366`: "the row that most needs an identifier which still resolves
after the next parser bump"), stores an id that resolves to two obligations. The database
indexes it (`requirements_by_stable_citation`) as though it were unique.

The mention collisions are a different shape and are benign for verification but not for
identity: one sentence with four keywords is four rows and one id, so the id cannot say which
keyword a caller was looking at.

### D.3 The claim's premise is false: the section number is a parse output

Claim 3 says the id is "derived only from the RFC number, the section number as a string, the
exact quote and an occurrence index — nothing that a re-parse changes." Three of the four are
safe. **The section number is not.** It is produced by heading detection in
`src/parse/text.ts` (`findHeadings` → `regions` → `sections.number`), it is gated on
`parser_version`, and this project ships parser bumps that change it as a matter of course. Its
own changelog, `CHANGELOG.md:223-231`:

> **An indented subsection title was body text, so the statements under it were unreachable.**
> … RFC 1122's outline was five entries long - 1 through 5 - and the 114 titles below it were not
> unreadable but unreachable … 4 838 titles recognised across the corpus, 19 documents gained
> sections and none lost any.

RFC 1122 in the corpus now has **122 sections** and 271 requirements distributed across numbers
like `4.2.2.13`, `3.2.2.9`, `3.2.1.8`. Before that bump the same rows sat under `1`…`5`. Since
`sectionNumber` is in the hash, **every `scit_` id in RFC 1122 minted by the previous parser is
invalid under the current one** — 271 obligations, one routine bump. That is the same failure the
design set out to eliminate, reproduced through the one input it assumed was inert.

`CHANGELOG.md:240-243` supplies the sharper case, and it is live in the corpus right now. RFC
768's section list is:

```
["", "User Datagram Protocol", "Introduction", "Format", "Fields", "User Interface",
 "28", "IP Interface", "Protocol Application", "Protocol Number", "References"]
```

A section numbered **`28`** — the front-matter date `28 August 1980` read as a heading. The
changelog says this was fixed; the number is still in the outline. A caller who recorded an
`scit_` against section `"28"`, and a caller who recorded one against `"Introduction"` (RFC 768's
titles carry no number, so `number === title`, `src/parse/text.ts:614`) are both holding ids
built from strings the parser manufactured from a typeset page. For an unnumbered section the
"section number" is the trimmed heading line, which is neither a number nor a published
identifier.

### D.4 The stability claim cannot be tested against this corpus

Zero RFCs have more than one snapshot, and the corpus has exactly one `parser_version`
(`rfc-text-1.7.3`) and one `extractor_version` (`normative-2119-8174-1.6.3`). There is no second
derivation of any document anywhere in the corpus, so the central empirical claim — that `scit_`
survives a re-derivation — has no data to run against here. The headline evidence cited in
`src/analysis/citation.ts:11-14` and `CHANGELOG.md:72-73` ("94 of 100 pinned snapshots … had to
be re-pinned") is from a 100-protocol corpus that is not this one, and I could not reproduce it
read-only. Marked untested, with the D.3 evidence standing on its own.

---

## E. What `verify_citation` returns, and whether a caller can learn the text

Established from the response shape, both live and from the working-tree source.

Live response keys on the top level: `["verdict", "matches", "notes"]`. Per match:
`["citation_id", "document_id", "snapshot_id", "source_uri", "locator", "quote",
"quote_sha256", "observed_at"]`. `locator` is `{section_path, block_id, span}` and `span` carries
all eight offset fields.

**The premise of the report note is wrong.** The quote _is_ echoed, under an obvious field name.
`matches[].quote` holds the text and `matches[].quote_sha256` its hash, on every verdict that
returns matches. A caller that got `verified` can learn exactly what was verified.

The real gap is narrower and sharper, and it is a function of the verdict:

| verdict                        | `matches` | caller can learn the text?                    |
| ------------------------------ | --------- | --------------------------------------------- |
| `verified` (`cit_`)            | 1+        | **yes** — `matches[].quote`, `quote_sha256`   |
| `verified` / `stale` (`scit_`) | 1+        | **yes** — same fields                         |
| `ambiguous`                    | 2+        | **yes** — every place, with its own span      |
| `stale` (`cit_`)               | 1+        | **yes**                                       |
| `not_found`                    | `[]`      | **no** — verdict, echoed id, one generic note |
| `integrity_failure`            | `[]`      | **no** — the citation is never examined       |

And the `not_found` hole is worse for `scit_` than the note suggests. With a `cit_` id, a caller
who stored the quote still holds it; losing the verdict costs them a re-read. **An `scit_` id is
a hash of the quote and cannot be inverted**, so a caller holding only the id cannot recover the
text from anything — not from the id, not from the response, not from the note. The `scit_`
`not_found` paths return `matches: []` and a note instructing the caller to pass `section`
(`src/service/rfcService.ts:2110-2117`), a value the id does not carry and the caller may not
have kept. On a corpus derived before the id existed, `src/service/rfcService.ts:2231-2237`
admits it: "A corpus derived before this id existed says this for every stable id until
`reanalyze --all`."

So the failure `src/analysis/citation.ts:11-14` sets out to fix — "`verify_citation` answered
`not_found` and the reader had no way to learn what the text was" — is **reproduced by the new
id on the `not_found` path**, and the new id is strictly worse here than the old one, because the
old one at least implied a lookup key the caller might still resolve by other means. What the
new id buys is stability; what it costs is the ability to recover the text on failure. A verdict
without the text is half an answer, and half of `verify_citation`'s verdict space
(`not_found`, `integrity_failure`) is still textless.

The second half-answer, and the one I think matters more: on `verified`, the caller gets the text
**and a span that does not address it** (§C.1). `quote` plus `locator.span` is the pair a caller
persists, and on every mention row and every candidate row that pair does not reproduce. A verdict
without a span that addresses the text is a verdict about a block.

---

## Verdict table

| #   | claim                                                                  | verdict                                                       | evidence                                                                                                                                                                                                                                                                                                                        | severity                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `Requirement` span addresses `exact_text` in all three units           | **holds**                                                     | 12 209 / 12 209 exact in char, byte and code-point; lengths and lines all consistent; `sections` 9 312 / 9 312 and `blocks` 64 103 / 64 103 likewise                                                                                                                                                                            | —                                                                                                                                                                              |
| 1   | `NormativeCandidate` span addresses `exact_text`                       | **broken**                                                    | **0 / 2 211** across 30 documents; span is the keyword (4 chars) against an 88-char `exact_text`; `normative.ts:1469-1477`; the identical correction is documented on the requirement path at `normative.ts:1261-1264` and was not applied here                                                                                 | **critical** — a candidate row's span and its text disagree 100% of the time, and a `provisional` compliance list built from these rows cannot be checked against the document |
| 1   | candidate span carries `codepoint_start/end`                           | **broken**                                                    | 0 / 2 211; the type omits them (`core/types.ts:400`)                                                                                                                                                                                                                                                                            | **high** — a caller cannot locate a candidate by code point at all, and the field's absence is not in the response                                                             |
| 1   | `NormativeMention` span addresses `exact_text`                         | **broken**                                                    | **0 / 12 358**; span is the keyword, `exact_text` is the sentence; the type advertises all eight offsets (`core/types.ts:252-262`)                                                                                                                                                                                              | **high**                                                                                                                                                                       |
| 1   | a row's `citation_id` is derived from the offsets it publishes         | **broken (mentions)**                                         | 12 358 / 12 358 mention ids reproduce from the **keyword** offset + the **sentence** text (`normative.ts:1188-1193`); requirements: 10 966 / 10 966 reproduce from the sentence offset + sentence text                                                                                                                          | **high** — the id names one string and locates another                                                                                                                         |
| 2   | code-point offsets are code-point offsets, not byte offsets            | **holds**                                                     | 12 209 / 12 209 match an independent code-point recomputation; 0 rows where a declared code point equals a byte offset that must differ; 2 962 rows correctly diverge from bytes; 0 spans land inside a surrogate pair                                                                                                          | —                                                                                                                                                                              |
| 2   | code-point offsets on the `scit_` path                                 | **broken, disclosed**                                         | hard-coded `0` at `rfcService.ts:2193-2194`; disclosed at `CHANGELOG.md:79-80`                                                                                                                                                                                                                                                  | **medium** — slicing a stable citation by code point yields the document's first code points, silently                                                                         |
| 2   | `verified` only when the bytes checked are the bytes the row came from | **broken**                                                    | `rfcService.ts:2369` checks `block_slice.includes(exact_text)`; the row's span is never read; the returned span is the block's (`rfcService.ts:2409-2418`). Live: mention `men_23189b20c839ab2f` returns `verified` with a 358-char span for a 118-char quote and an 8-char row span                                            | **critical** — a `verified` citation does not attest that any span in it addresses the quote; the span/quote pair a caller persists does not reproduce                         |
| 2   | `stale` when the bytes are not the row's                               | **broken (`cit_`)**                                           | 23 324 / 23 324 stored citations contain their quote in their own block; 0 can be `stale`. The "different derivation" case returns `not_found`, because the lookup is snapshot-scoped and the snapshot id embeds the parser version                                                                                             | **high** — the verdict the claim names is unreachable; the case it names produces a different verdict                                                                          |
| 2   | `stale` on the `scit_` path                                            | **untested**                                                  | reachable by construction (`rfcService.ts:2222-2237`); the path throws on this corpus — `no such column: stable_citation_id`                                                                                                                                                                                                    | —                                                                                                                                                                              |
| 2   | `ambiguous` when the text stands more than once                        | **holds, with an overloaded branch**                          | 20 requirement/mention `cit_` collisions all stand in exactly 1 place and are deduped at `database.ts:1352-1357` — a false `ambiguous` that I could not construct. But two disagreeing locators return `ambiguous` with 3 matches over 2 distinct texts, neither of which repeats                                               | **medium** — the verdict conflates "two places" with "two locators"                                                                                                            |
| 2   | the named `ambiguous` test case (RFC 2865 §5.11 / §5.18)               | **does not fire**                                             | the sentence occurs 3× in RFC 2865, none as the quoted one-liner, and all in different sections, so three distinct ids; `ambiguous` is confined to one section by construction                                                                                                                                                  | —                                                                                                                                                                              |
| 2   | `not_found` when the text is absent                                    | **holds, under-informative**                                  | reachable; but a truncated hex id, an absent-but-valid id and a non-id string all return byte-identical responses                                                                                                                                                                                                               | **medium**                                                                                                                                                                     |
| 2   | `integrity_failure` when the bytes do not hash to the recorded sha256  | **unreachable by a caller**                                   | `raw_sha256` and `raw` come from one `Buffer` (`rfcService.ts:480`, `:552`); 181 / 181 snapshots hash correctly, 0 NULL/empty. The citation is never examined on that path                                                                                                                                                      | **low** — a corruption tripwire, not a verdict about a citation                                                                                                                |
| 3   | `scit_` is invariant to block id, offsets, snapshot id, versions       | **holds**                                                     | no such input appears in `citation.ts:89-91`; the `cit_` problem is real, since the snapshot id embeds the parser and extractor versions (`rfcService.ts:489`)                                                                                                                                                                  | —                                                                                                                                                                              |
| 3   | `scit_` changes when section number, text or occurrence changes        | **holds for section and text; the occurrence input is inert** | all three are in the hash; but `database.ts:1738` never passes `occurrence`, so it is always 0 and never distinguishes two copies                                                                                                                                                                                               | **medium**                                                                                                                                                                     |
| 3   | two genuinely different statements never share an `scit_`              | **broken**                                                    | 10 requirement ids each carried by 2 rows in 2 different blocks (RFC 1812 §4.2.2.11, RFC 2845 §4); 1 125 mention ids carried by >1 row; 12 101 mention ids also minted by a requirement. `verify_citation` answers `ambiguous`, but `stable_citation_id` is indexed as if unique and is the handle a contract is meant to store | **critical** — two distinct obligations under one citation id, and the id is the documented long-lived handle                                                                  |
| 3   | "nothing that a re-parse changes"                                      | **broken**                                                    | `sectionNumber` is a `findHeadings` output. `CHANGELOG.md:223-231`: a routine bump took RFC 1122 from a 5-entry outline to 122 sections — 271 requirements, every `scit_` id changed. RFC 768's outline still contains a section numbered `28` (`CHANGELOG.md:240-243`)                                                         | **critical** — the one input assumed inert is the input the project changes most                                                                                               |
| 3   | `scit_` survives a re-derivation                                       | **untested**                                                  | 0 RFCs have two snapshots; one `parser_version`, one `extractor_version`; the path throws on this corpus                                                                                                                                                                                                                        | —                                                                                                                                                                              |
| —   | candidate citations are usable in bulk                                 | **broken**                                                    | one verification: RFC 9110 1080–7357 ms, RFC 793 2478 ms, via a per-token brute force over every block (`rfcService.ts:1993-2018`)                                                                                                                                                                                              | **high** — the advertised pre-1990 compliance-list path is minutes per document                                                                                                |

## What I tried that did not work

Recorded so the negative results are not mistaken for absence of effort.

- **False `ambiguous` on the `cit_` path.** 20 requirement/mention id collisions, every one a
  sentence beginning with its keyword, every one standing in exactly 1 place. The dedupe at
  `database.ts:1352-1357` defeats all 20. Confirmed live on two of them. Not a finding.
- **A `stale` citation on the `cit_` path.** Searched for any stored row whose quote is absent
  from its own block: 0 of 23 324. Re-derived rather than sampled.
- **A code-point offset that is a byte offset in disguise.** 12 209 rows, independent prefix
  tables, zero cases. The 2 962 rows where byte and char diverge carry the right divergence.
- **A span splitting a surrogate pair** (which would make `mapCharOffsets` overshoot the byte
  count by 4). Checked `char_start` and `char_end` on all four span-bearing tables: zero.
- **A `scit_` collision between two different texts.** Not constructible from
  (rfc, section number, quote, occurrence) short of a 96-bit sha-256 prefix collision. The
  collisions that exist are same-text collisions, and they are real (D.2).
- **`stale`, `ambiguous` and `verified` on the `scit_` path.** Not attempted against a binary:
  the feature is unbuilt and unmigrated, and the first statement of the resolution path raises
  `no such column: stable_citation_id`. Attempted and abandoned, with the failure recorded.

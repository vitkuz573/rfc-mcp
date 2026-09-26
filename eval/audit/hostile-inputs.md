# Adversarial audit: hostile input against `rfc-mcp`

Auditor session, read-only on `src/`. Nothing in the repository was built, committed, or
written except this file. The real corpus at `~/.local/share/rfc-mcp/corpus.sqlite` was
never opened.

## How this was run

| lever          | what I used                                                                                                                                     | where the code reads it                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| scratch corpus | `RFC_MCP_DATA_DIR=/tmp/rfc-mcp-audit-XXXX` (fresh mkdtemp per run)                                                                              | `defaultDataDir()` — `src/core/config.ts:118`                                                                                                                                                                            |
| offline mode   | `RFC_MCP_OFFLINE=1`                                                                                                                             | `loadConfig()` — `src/core/config.ts:133`                                                                                                                                                                                |
| current source | `src/*.ts` transpiled to `/tmp/audit/build` with `ts.transpileModule`                                                                           | throwaway; `dist/` was **stale** (built 12:31, `src/analysis/normative.ts` and `src/service/rfcService.ts` modified 13:07/12:59 with 1551 uncommitted insertions), so auditing `dist/` would have audited the wrong code |
| hostile bytes  | in-memory Buffers committed through `CorpusStore.commitDocument` exactly as `RfcService.reanalyze` does (`src/service/rfcService.ts:2795-2822`) | no network, no operator surface                                                                                                                                                                                          |
| real documents | `https://www.rfc-editor.org/rfc/rfcNNNN.txt` fetched to `/tmp/audit/real`                                                                       | rfc-editor.org, the tool's own primary source                                                                                                                                                                            |

Timing is wall-clock on this host. Costs are reported separately for the **operator**
surface (`sync` / `reanalyze`, which parse) and the **model** surface (MCP tools, which read
SQLite), because they have completely different cost profiles and only one of them is
attacker-reachable in a running server.

Headline: on a **correctly formed** corpus the tool is in good shape. `requirements()` on the
largest real document (RFC 3261, 648 KB, 995 requirements) is 0.65–1.03 s, and the loss
counter is genuinely not counted per query any more (5 calls = 3.8 s). Every hang and every
confidently-wrong number below is either an ingest-time cost or a **missing disclosure on a
real document**. Three of the six criticals reproduce against unmodified bytes served by
rfc-editor.org today.

---

## 1. CRITICAL

### C1. An HTML error page becomes an RFC, and its marketing prose becomes `parse_status: complete`, `verify_citation: verified` requirements

**A caller sends:** nothing. An operator runs `rfc-mcp sync rfc 9999`; rfc-editor.org (or a
CDN, captive portal, or edge worker in front of it) answers `200 OK` with
`Content-Type: text/html` and a 503 body. The bytes are stored and parsed.

**What happens:**

- `RfcEditorSource.fetchPublication` (`src/upstream/sources.ts:227-263`) sends
  `Accept: text/plain`, records `result.contentType` at line 253 — and **never compares it
  to `format`**. `src/upstream/http.ts:267` only rejects non-200/404. `contentType` is
  written to the asset row (`src/store/database.ts:873`, read back at
  `src/service/rfcService.ts:2311`) and never inspected. There is no DTD/`<!doctype` sniff
  on the text path; `src/parse/xml.ts:97` has that check and only for XML.
- `parseRfcText` degrades (`no_section_headings_detected`, `no_body_sections_detected`) and
  happily makes one section out of the whole page.
- `requirements(rfc=9001)` returns, with **`status: "ok"`**:

```
total_requirements: 2     parse_statuses: ["complete"]     warnings: ["snapshot_not_explicitly_pinned"]

row 1 exact_text: "<!DOCTYPE html>\n<html><head><title>503 Service Unavailable</title></head>\n
<body><h1>Sorry, the RFC 9000 text could not be retrieved</h1>\n<p>The server MUST be restarted."
  verify_citation(cit_8210e767...) -> verdict "verified", notes ["quote matches bytes 0..220 (lines 1..5)"]

row 2 exact_text: "Operators MUST NOT ignore this.</p>\n</body></html>"
  verify_citation(cit_efc42f50...) -> verdict "verified"
```

**Would it be trusted:** yes, and that is the problem. `parse_status: "complete"` is the
strongest per-row claim the contract has, `verify_citation: verified` is the strongest
citation claim, and both are false — the RFC does not say "The server MUST be restarted", an
HTML `<h1>` does. The one hedge available, `parse_quality_degraded`, appears **only** on
`resolve` (rfcService.ts:671). `requirements`, `read` and `metadata` do not emit it, and
`metadata`'s `data.snapshot.quality` is the only machine-readable field that says
`degraded` — a caller asking for a compliance list never sees it.

The `scit_` stable citation on the same rows is `not_found` and unresolvable ("a stable id
names a section as well as a text, so `section` is required") because there is no section to
name. So the citation kind that is supposed to survive a re-derivation is the one that
fails, and the kind that works only proves "these bytes are in this snapshot".

**Responsible:** `RfcEditorSource.fetchPublication` (no content-type check);
`parseRfcText` `quality` gate (`src/parse/text.ts:327`, only `no_*` warnings count);
`RfcService.ensureSnapshot` cached path (`rfcService.ts:437` returns `warnings: []`).

---

### C2. Invalid UTF-8: the parser knows its byte offsets are wrong, stores them anyway, marks the snapshot `complete`, and `verify_citation` confirms the wrong bytes

**A caller sends:** a Latin-1 RFC. Pre-1990 documents are routinely Latin-1; the corpus is
explicitly built to handle them.

**What happens** (file `1. Requirements\n\nCaf\xe9 r\xe9sum\xe9. The server MUST reply now.\n`):

```
TRUE byte offset of "The server MUST" in the file .............. 30
requirement exact_text ....................................... "The server MUST reply now."
requirement span .............................................. byte_start 36   (off by 6)
raw.subarray(36, 62) .......................................... "rver MUST reply now.\n"
   => does the reported byte span contain the quote? .......... false
verify_citation(cit_84ba8c8c) -> verdict "verified"
   notes: ["quote matches bytes 17..62 (lines 3..3)"]
```

The snapshot row carries `byte_offsets_approximate_invalid_utf8` and
`source_contains_replacement_characters`. Neither reaches the caller:

- `quality` is computed as `warnings.some(w => w.startsWith("no_") || w === "toc_unterminated")`
  (`src/parse/text.ts:327`). `byte_offsets_approximate_invalid_utf8` does not start with
  `no_`, so the snapshot is `complete`, so `parse_quality_degraded`
  (rfcService.ts:671) never fires.
- `RfcService.ensureSnapshot`'s cached path returns `warnings: []` (rfcService.ts:437), and
  the pinned path in `anchor()` returns `warnings: []` (rfcService.ts:649). The only reader
  of `snapshot.warnings` in the whole service is `resolve`, into a nested
  `analyses.warnings` field (rfcService.ts:679) — not the branchable envelope array.

**The verifier compounds it.** `RfcService.verifyCitation` (rfcService.ts:2390-2399):

```ts
const slice = raw.subarray(block.byte_start, block.byte_end).toString("utf8");
if (slice.includes(match.exact_text)) {
  verdict = "verified"; /* note quotes the BLOCK range */
} else if (decodedText(raw, block.char_start, block.char_end).includes(match.exact_text)) {
  verdict = "verified"; /* this branch carries the "byte offsets are approximate" note */
}
```

It validates the quote against the **block's** byte range, never against the stored
record's own `span`, and the note it prints ("quote matches bytes 17..62") is the block
range — a number a caller will read as "my quote is at 17..62" when the row says 36..62.
Two different byte ranges, one wrong, `verified`. And because `.toString("utf8")` on invalid
bytes yields U+FFFD, an all-ASCII quote still matches in branch 1, so the
"byte offsets are approximate for this snapshot" note is **unreachable** for exactly the
input that needs it. There is no defence in depth behind the stored warning.

**Would it be trusted:** yes. `verified` is the value a caller gates a contract on, and the
guarantee advertised in `capabilities` is "Every derived statement carries a citation id and
exact byte/char/code-point/line offsets".

**Reachability, stated honestly:** today's rfc-editor.org output is valid UTF-8. I checked
RFC 1, 100, 768, 792, 959, 1000, 1122, 2822, 3261, 9110 — the only non-ASCII bytes are
valid UTF-8 sequences (RFC 9110 has 64 such bytes plus a UTF-8 BOM at offset 0). So this is
**latent against the live upstream**, not live. It becomes live the moment a snapshot is
hand-placed, restored from an older backup, or fetched through a re-encoding proxy — and the
code contains no gate that would catch it.

**Responsible:** `parseRfcText` (stores approximate offsets while flagging them);
`verifyCitation` (validates block span, not record span; approximate-offsets branch
unreachable); the `quality` predicate at `src/parse/text.ts:327`.

---

### C3. 2000 `MUST` lines, one block: `total_requirements: 1`, all three loss counters read zero, no warning

**A caller sends:** `requirements(rfc=N)` on a document of 2000 lines each reading `MUST`
(any text with no terminal punctuation behaves this way: a keyword table, a syntax listing,
a botched conversion, an HTML page whose text got flattened).

**What happens:**

```
fixture bytes .................. 10 017, of which 2000 are the token MUST
sections 1, blocks 1, kind paragraph
coverage.total_requirements .... 1
coverage.blocks_scanned ........ 1
coverage.blocks_skipped ........ 0
coverage.keyword_bearing_blocks_skipped ... 0
mentions (response) ............ 500
parse_status of the one row .... "partial"
warnings ...................... ["snapshot_not_explicitly_pinned"]
```

`sentences_scanned: 1`. The 2000 lines are one non-blank chunk, so `splitSentences`
(`src/analysis/normative.ts:1831`) finds no `[.!?]` boundary and emits one "sentence" of
9999 characters; `analyzeNormative` promotes it to one requirement whose `exact_text` is
`"MUST\nMUST\nMUST\n…"` repeated 2000 times.

**Would it be trusted:** yes. This is precisely the failure mode the brief names. Every
counter a caller is told to check before concluding a document is thin —
`blocks_skipped`, `keyword_bearing_blocks_skipped`, `blocks_skipped_by_kind` — reads **zero**.
The 2000 keyword occurrences survive only in `mentions`, which `requirements()` fetches with
a hard-coded `getMentions(snapshot.id, 500)` (rfcService.ts:1389): **500 of 2000, with no
`truncated` flag, no `next_cursor`, and no `mentions_found` in `coverage`** (the coverage
keys are `total_requirements, returned, section_filter, term_filter, keyword_filter,
blocks_scanned, prose_blocks_scanned, blocks_skipped, blocks_skipped_by_kind,
keyword_bearing_blocks_skipped, unscanned_note`). 1999 statements are unreachable and
nothing says so. The single `parse_status: "partial"` describes the one row's clause
grammar, not the count.

**Responsible:** `splitSentences` (no sentence ⇒ no requirement, no count of the loss);
`analyzeNormative`'s coverage block (no counter for keyword occurrences that did not become
statements); `getMentions` hard-coded 500 at the call site.

---

### C4. `analyzeNormative` is quadratic in block length: 33 s for 115 KB, unbounded above

**A caller sends:** a file whose body is one unbroken line.

**What happens** (one line, N repetitions of `The server MUST reply. `, then a normal
`1. Introduction` heading):

|     N | block chars | `parse` | `analyzeNormative` |
| ----: | ----------: | ------: | -----------------: |
|   100 |       2 300 |   25 ms |              94 ms |
|   400 |       9 200 |   39 ms |             736 ms |
|   800 |      18 400 |   35 ms |           2 027 ms |
| 1 600 |      36 800 |   21 ms |           5 221 ms |
| 3 200 |      73 600 |   35 ms |      **11 985 ms** |
| 5 000 |     115 018 |   35 ms |      **33 293 ms** |

Parse time is flat; the cost is entirely in the extractor. Control experiment holding the
sentence count fixed and varying only block length:

```
3 200 sentences in 3 200 blocks of 30 chars .......  689 ms
3 200 sentences in 1 block of 73 600 chars ....... 13 363 ms   (19x, same answer)
25 600 sentences in 25 600 short blocks ......... 3 364 ms   (linear)
```

**The offending expressions** are four per-sentence calls that re-scan the whole block:
`byteOffsetFromChar` (`src/analysis/normative.ts:1964` —
`Buffer.byteLength(block.text.slice(0, relative))`) and
`codePointCount(block.text.slice(0, sentence.start …))` at lines **1169, 1172, 1259, 1261**,
all inside the per-sentence loop opened at `src/analysis/normative.ts:1109`. Each is O(block
length); there are O(sentences) of them.

At N = 190 000 (a 4.6 MB single line) the run **did not finish in 300 s** (killed,
`timeout 300`, exit 124). Quadratic extrapolation from N = 3 200 puts it in the hours.

**Which surface:** this is **operator-side only**. `requirements()` on the same document is
271 ms, because the strict requirements are read from SQLite and the per-call candidate pass
is flat (`analyzeNormativeCandidates`: 500 candidates at N = 2 000 / 4 000 / 8 000 / 16 000 →
111 / 109 / 78 / 113 ms). So `sync rfc` and `reanalyze --all` can be destroyed by one line of
a document; a running read-only server is not.

**Reachability, stated honestly:** not from rfc-editor.org. I measured the largest line in
ten real RFCs: 72–85 bytes (RFC 3261: 72; RFC 9110: 85; RFC 1: 77). `largestBlockChars` is
2 666 for RFC 3261 and 6 302 for RFC 9110, far below the ~70 KB where this bites. This is
reachable through a hand-placed file, a re-encoded proxy, or a PDF→text conversion — not
through the live corpus. Note the fix that produced the 29 s → sub-second improvement was on
the _loss counter_; the _extractor_ carries the same class of defect and was not measured.

**Responsible:** `analyzeNormative` (loop at 1109) with `byteOffsetFromChar` (1964) and
`codePointCount(block.text.slice(0, …))` (1169, 1172, 1259, 1261).

---

### C5. `read(max_output_bytes=…)` does not bound the response, and the `byte_cursor` it hands back is a dangling pointer

**A caller sends:** `read(rfc=3261, section="20", max_output_bytes=64)`. Section 20 of RFC
3261 is a real 4 039-character section; the file is the real, unmodified 648 KB publication
text.

**What happens:**

```
max_output_bytes=    64 -> text=64ch  text_verbatim=4039ch  truncated=true  byte_cursor=409526  RESPONSE=18.1 KiB
max_output_bytes=  1024 -> text=1024ch text_verbatim=4039ch  truncated=true  byte_cursor=409526  RESPONSE=20.0 KiB
max_output_bytes= 16384 -> text=3749ch text_verbatim=4039ch truncated=false byte_cursor=null      RESPONSE=25.5 KiB
```

`text_verbatim` is assigned the untruncated section text at rfcService.ts:1089 with no byte
budget applied, so a caller asking for 64 bytes receives 18 KiB and the full section. The
`maxOutputBytes: 16384` limit advertised in `capabilities.limits` is enforced on `text` only.

Then, the continuation:

```
byte_cursor offered ................ 409526
same call + offset_bytes=409526 ... first 40 chars: "   The general syntax for header fields "
                                     (identical to page 1 -> offset_bytes was ignored)
target=raw_slice + offset_bytes .... works, but addresses the whole file, not the section
```

`input.offset_bytes` is read in exactly one place, the `raw_slice` branch
(rfcService.ts:970). The section branch (rfcService.ts:1055-1061, 967-1006) truncates,
sets `byte_cursor: resolvedSection.byte_end`, and never looks at `offset_bytes`. So the
field names a position this tool will not accept, and the tail of any over-budget section
is **unreachable**.

**Live on real documents:** RFC 3261 has **5** sections over 16 384 bytes (largest 26 332)
and RFC 9110 has **1** (21 191). Those 6 sections are partially readable and uncontinuable
today, on bytes served by rfc-editor.org.

**Would it be trusted:** yes — `truncated: true` plus a `byte_cursor` is precisely the
"here is how to continue" contract, and following it silently returns page 1 again. A caller
that loops on `byte_cursor` gets an infinite loop of identical text and no error.

**Responsible:** `RfcService.read` — the `text_verbatim` assignment (rfcService.ts:1089) and
the section branch's omission of `offset_bytes` (1055-1061).

---

### C6. `listBlocksWithKeywords`' 5 000-block bound is undisclosed and makes `scanned_blocks` a wrong number

**A caller sends:** `requirements(rfc=N)` on a document with 6 000 keyword-bearing blocks.

**What happens:**

```
document .................... 6 001 blocks, 6 000 of them keyword-bearing
coverage.total_requirements . 0
non_strict_candidates.total . 500        rows=500
non_strict_candidates.scanned_blocks ... 501        <-- the document has 6 001
warnings ................... ["snapshot_not_explicitly_pinned",
                             "candidates:candidates_truncated_at_500",
                             "zero_or_few_requirements_but_500_non_strict_candidates:read_non_strict_candidates"]
"5000" appears anywhere in the response? false
next_cursor for candidates?  no
```

`requirements()` calls `this.store.listBlocksWithKeywords(snapshot.id)`
(rfcService.ts:1395) with no limit, and the store's default is `limit = 5000`
(`src/store/database.ts:1201`). The 1 001 dropped blocks are disclosed **nowhere**: not in
`limits`, not in `appliedLimits`, not in a warning, not by a cursor. The response instead
asserts `scanned_blocks: 501`, which reads as a census of the document and is off by a factor
of twelve. The `candidates_truncated_at_500` warning is true but is about a _different_ cap
(the 500-row candidate ceiling) and gives a caller no reason to think 5 000 blocks were
skipped.

**Would it be trusted:** yes. `non_strict_candidates` is the documented remedy for "a zero
count means nothing" — `capabilities.reading_rules[0]` tells the caller to read it before
concluding absence. Here the remedy is itself computed from a silently truncated subset and
reports a `scanned_blocks` count that is simply wrong.

**Reachability:** needs > 5 000 keyword-bearing blocks in one document. The corpus's largest
is RFC 3261 with 2 078 blocks. Not reachable from today's corpus; reachable from any hostile
or synthetic file.

**Responsible:** `CorpusStore.listBlocksWithKeywords` default 5000 (database.ts:1201) and its
call site in `requirements` (rfcService.ts:1395).

---

## 2. HIGH

### H1. The same 5 000 000-byte input takes 14.7 s to parse, and it is all page-furniture detection

`5mb_blank_lines` (5 000 000 `\n`): **14 717 ms, 100 % in `parseRfcText`**. Linear, not
superlinear: 10 000 blank lines = 42 ms, so ~2.9 ms/KB. 10 000 blank lines (the brief's case)
is 42 ms and fine; 5 MB is 14.7 s and is an unbounded function of file size with no ceiling
anywhere in the ingestion path. The cost is `lines.filter(line => isPageFurniture(line))`
at `src/parse/text.ts:134` — every line is tested against all nine `PAGE_FURNITURE` patterns
(`src/parse/text.ts:89-107`) before anything else, so 5 M lines = 45 M regex evaluations.
`isPageFurniture` is then called again per line inside `findHeadings` and again per line
inside `collectLines`. Operator-side only. Responsible: the filter at text.ts:134 and
`isPageFurniture`.

### H2. 10 001 sections all numbered `1.`, zero warnings, 4.5 MB outline, 10 000 of them unaddressable

`section_number_10000x` (10 000 lines reading `1. Introduction`):

```
sections=10002   parser warnings=[]   quality=complete
outline entries=10002  distinct numbers=2  response=4588 KiB
read(section="1") -> the first one.  How many are reachable by number? 1.
```

`sectionIds` is keyed by index (text.ts:160-163) so the ids do not collide, but
`getSectionByNumber` returns one row, so 10 000 sections exist, are listed in the outline at
4.5 MB in a single response, and are unreachable — with no duplicate-number warning anywhere.
`MAX_HEADING_CHARS` does not cap section _count_ and no limit in `capabilities.limits` is a
section count. Responsible: `findHeadings` (no duplicate detection) and `read(target=outline)`
(no bound).

### H3. Silent clamps on `search` and `references`; only `requirements` reports its clamp

`requirements` was fixed to warn. The other two were not, and they do not agree:

```
requirements max_results=201 -> applied {max_results:200}  warns ["max_results_clamped:201->200:..."]   REPORTED
search      max_results=199 -> applied {max_results:20}   warns []                                      SILENT
search      max_results=200 -> applied {max_results:20}   warns []                                      SILENT
references  max_results=200 -> applied {max_results:100}  warns []                                      SILENT
read      max_output_bytes=10 -> applied {max_output_bytes:64}  warns []                                SILENT
search        context_chars=10 -> applied {context_chars:40}    warns []                                SILENT
dependencies     depth=4        -> applied {depth:3}         warns []                                    SILENT
dependencies  max_nodes=201     -> applied {max_nodes:200}   warns []                                    SILENT
diff         max_changes=501    -> applied {max_changes:500} warns []                                    SILENT
```

Mitigation for the three that page: `search` and `references` do return a real envelope-level
`next_cursor` (I initially misread `data.next_cursor` and have corrected this), so the rows are
recoverable. The defect is the _silence_: the number the caller sent is discarded and only
`limits.applied` — which a caller must diff against its own request — records it. `read`,
`context_chars`, `dependencies` and `diff` clamps are both silent **and** final.

On the MCP path the zod schemas in `src/service/inputSchemas.ts` reject out-of-range values
first, so most of this is only reachable through the CLI, which parses `--max N` with
`Number.parseInt` (`src/cli.ts:125`) and whose human formatters never print
`envelope.warnings` at all (`src/cli.ts:300-332`) — `rfc-mcp requirements 2119 --max 5000`
prints `total: 200` and nothing else. Responsible: the `clamp()` sites listed above, and
`src/cli.ts` for the human surface.

### H4. Two advertised limits do not exist

`capabilities.limits` publishes 15 numbers. `maxRawSliceBytes: 262144` and
`maxCompletionValues: 20` are **referenced nowhere in `src/` outside `core/config.ts`** —
grepped, zero hits. `read(target=raw_slice)` actually uses
`clamp(max_output_bytes ?? 16384, 64, 4 MiB)`, so a raw-slice page is 4 MiB, sixteen times
the advertised bound. `maxQuoteChars: 1200` is referenced only in the prose note admitting
it is not enforced — that one is honestly labelled. Responsible: `DEFAULT_LIMITS`
(`src/core/config.ts:70-86`).

### H5. No output bound on `requirements`, `search`, `metadata`, `outline` — 1.7 MB from one call, live on the real corpus

`src/mcp/tools.ts:84` is `JSON.stringify(envelope)` with no cap. `maxOutputBytes` is
enforced only inside `read`. Measured single-response sizes:

```
RFC 3261 (real, 995 requirements)  requirements() .........  797 KiB   (max_results defaulted to 20)
RFC 3261 (real)                   requirements(max=200) ... 1011 KiB
RFC 3261 (real)                   read(target=outline) ...  172 KiB
synthetic 1200-req + 900-cand doc requirements() .......... 1179 KiB
synthetic, max_results=1 .................................. 1144 KiB
synthetic, max_results=1 + include_provisional ............ 1774 KiB
10 001-section document           read(target=outline) ... 4588 KiB
```

`mentions` (500 rows) and `non_strict_candidates` (500 rows) are shipped regardless of
`max_results`, and `include_provisional` appends another 500. So the payload a caller receives
has nothing to do with the number it asked for, and is ~64× the advertised byte limit on the
real corpus's largest document. `max_results=1` returns 1.1 MB.

### H6. `batch` multiplies the worst per-call cost by ten with no budget or deadline

```
single requirements() on a hostile 10 000-MUST document ..... 3 817 ms
batch of 10 of them, one MCP request ........................ 41 497 ms   status: "ok"
real corpus worst case (RFC 3261) 10x ....................... ~7 600 ms
```

`maxBatchOperations: 10` (rfcService.ts:2588) bounds the operation _count_ and nothing else.
There is no per-request byte or time budget anywhere in `batch` or in the tool wrapper. One
request, 41 s, no progress, no cancellation on the model-visible path.

### H7. A form feed inside a sentence ships inside the quoted requirement, unflagged

```
exact_text: "The server MUST reply to\f every request."
parse_status: "complete"   verify_citation: verified   warnings: ["snapshot_not_explicitly_pinned"]
```

`isPageFurniture` (text.ts:374) tests the _whole line value_ against `/^\f+\s*$/` and the
nine `PAGE_FURNITURE` patterns, and `collectLines` only marks a line as furniture when the
line _is_ furniture. A `\f` at column 30 of a line is ordinary character data to every test in
the parser. The `furniture_lines` mechanism (which exists precisely so "a caller copying
`text` picked up an invisible control character" cannot happen, per the comment at
text.ts:698-703) only works line-aligned. A caller copying that `exact_text` into a
specification gets U+000C in the middle of a normative sentence with nothing on the response
saying so. Responsible: `isPageFurniture` / `collectLines` — the granularity is the line, and
the contract claims byte granularity.

### H8. Lone CR is not a line separator at all

`cr_only` (`"1. Requirements\r\rThe server MUST reply.\r\rA client MAY ask.\r"`, no LF
anywhere):

```
sections=1  blocks=1  total_requirements=1   (the file holds 2 keywords)
quality=degraded  warnings=["source_has_no_trailing_newline","table_of_contents_header_not_found",
                             "no_section_headings_detected","no_body_sections_detected"]
exact_text="Requirements\r\rThe server MUST reply.\r\rA client MAY ask."
parse_status="complete"  verify_citation="verified"
```

`splitLines` (text.ts:358) splits on `\n` and only strips a trailing `\r`; a bare CR is
neither. The whole document becomes **one line**, the section heading is rejected (its
`isHeadingLike` test fails on the trailing `.`), and one requirement is emitted whose
`exact_text` is the entire file including its carriage returns — at
`parse_status: "complete"`. The `degraded` status is correct but the _cause_ is not named:
no warning mentions line endings. RFC 4830-era and typeset files are exactly this shape.
Responsible: `splitLines` (text.ts:358-372).

---

## 3. MEDIUM

| #   | input                                                                       | behaviour                                                                                                                                                                                                          | why it matters                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | NUL bytes mid-sentence                                                      | `1. Requirements\n\nThe server MUST reply. \x00\x00 A client MAY ask.\x00` → 1 requirement from 2 keywords, `quality: complete`, no warning. NUL is not tested anywhere.                                           | a NUL silently changes what `splitSentences` sees; `sanitizeSnippet` (util.ts:82) only guards logs, not stored text                                                                                                                    |
| M2  | table with 300 `MUST NOT` cells                                             | `total_requirements: 0`, but `keyword_bearing_blocks_skipped: 1`, warning `normative_text_in_unscanned_blocks:1:out_of_scope_by_design`, and 1 candidate row                                                       | the disclosure works, but the count is a **block** count: 300 statements are described as "1", and the candidate list the warning points at has 1 row, not 300. A caller checks the counter, sees 1, and moves on                      |
| M3  | TOC promises 5 000 sections, body has 3                                     | warning `toc_sections_without_a_heading:` lists only the first 20 numbers (`missing.slice(0, 20)`, text.ts:156) with no "…and 4 977 more"                                                                          | a 20-item list is indistinguishable from a 20-item list; the real shortfall is unrecoverable from the warning. And the warning is invisible outside `resolve` (C2's mechanism)                                                         |
| M4  | heading line 5 000 chars                                                    | rejected (`col0_numbered_items_kept_as_blocks:1`), the section is lost, `quality: complete`                                                                                                                        | disclosure exists but lands in the invisible `snapshot.warnings`                                                                                                                                                                       |
| M5  | 5 000 indented subsections                                                  | recognised correctly (5000 sections, 5000 requirements), 4 194 ms ingest                                                                                                                                           | the feature works; it is the documented `indented_subsection_headings_recognised:N` path, and **RFC 9110 — live — takes it 257 times** (warning stored, invisible outside `resolve`)                                                   |
| M6  | UTF-8 BOM                                                                   | RFC 9110 has one at offset 0. `source_starts_with_bom` fires, offsets stay correct, `quality: complete`                                                                                                            | correct behaviour, wrong place: the fact is recorded and never surfaced. Same for `page_furniture_lines_dropped:N` (fires on my control document) and `col0_numbered_items_kept_as_blocks:N` (RFC 1034/2119 by the code's own comment) |
| M7  | `read(section=…)` for a 100 001-section doc returns a 4.5 MB outline        | one call, 4 588 KiB, `truncated: false`                                                                                                                                                                            | H5/H2 combined; no count limit exists                                                                                                                                                                                                  |
| M8  | PNG header, gzip magic, 16 and 13 bytes                                     | `quality: degraded`, `source_contains_replacement_characters`, `byte_offsets_approximate_invalid_utf8`, 1 section, 0 requirements, `requirements()` status `ok` with `candidates:no_blocks_scanned_for_candidates` | honest enough: degraded is in the row, a zero-count warning is raised. But no "this is not text" signal exists, and the count 0 has the same shape as a real zero                                                                      |
| M9  | 4 000 unclosed-quote lines                                                  | 4 000 requirements, 6 000 mentions, 2 000 blocks, 3 330 ms, `parse_status` mixed                                                                                                                                   | the splitter survives it — genuinely good. Reported for completeness                                                                                                                                                                   |
| M10 | `read(target=raw_slice)` at a byte offset that splits a multi-byte sequence | `raw.subarray(start, start+maxBytes).toString("utf8")` (rfcService.ts:972) is not `truncateBytes`, which _does_ handle the boundary (util.ts:53-62)                                                                | every page boundary of a non-ASCII document yields a U+FFFD in the middle of the slice, with no warning. Did not reproduce on my ASCII fixtures                                                                                        |
| M11 | `max_results` pagination                                                    | requirements paginate correctly (3 pages, 600 distinct rows, `omitted_on_page` correct on pages 2/3); candidates ship on page 1 only with a stub after, as documented                                              | this part is honest and was clearly already fixed. `mentions` is the exception (C3)                                                                                                                                                    |
| M12 | `ensure_rfcs` / `ensure_top_catalog_hits`                                   | `search(ensure_rfcs=[…20 RFCs])` and `ensure_top_catalog_hits=20` each ingest **20 documents inside one model call**                                                                                               | the 20-cap and the 10-op batch cap compose to 200 ingests, i.e. 200 × the 2.96 s worst-case real ingest, inside one `batch` request                                                                                                    |
| M13 | CLI human output                                                            | `src/cli.ts` formatters for `requirements`, `references`, `search`, `show`, `outline` never print `envelope.warnings`                                                                                              | every warning in this report is invisible to an operator using the CLI, which is the surface that runs ingest and reanalyze                                                                                                            |

---

## 4. What behaved correctly

Recording these because they are the load-bearing parts of the design and the next person
should not "fix" them:

- **Zero-input guards.** Empty file, single `\n`, whitespace-only, 10 000 blank lines, 5 MB
  of blank lines, 1 000 form feeds, front-matter-only, body-with-no-sections, one 200 001-char
  line — every one returns `quality: degraded` with a `no_*` cause, `sections: 0`,
  `total_requirements: 0` and a `no_prose_blocks_scanned` / `no_blocks_scanned_for_candidates`
  warning. No crash, no hang, no invented content. `read(section=…)` on them is an honest
  `NOT_FOUND` with `snapshot_id` in `details`.
- **Type-driven block classification.** The 500-cell table with 4 000 characters of payload per
  cell and `MUST NOT` in each was classified `table` (not `paragraph`), skipped, counted in
  `keyword_bearing_blocks_skipped`, warned about, and its statements were recovered as 500
  candidate rows — the exact case the last commit set out to fix.
- **The candidate cap is honest.** `candidates_truncated_at_500` fires and names the limit;
  the candidate pass is flat in block length (111/109/78/113 ms at N = 2 000/4 000/8 000/16 000).
- **The loss counter regression is genuinely fixed.** 5 × `requirements()` on RFC 3261 = 3 811 ms,
  ~760 ms each. `keyword_bearing_blocks_skipped` is read from the snapshot row
  (rfcService.ts:1353), not counted per query.
- **The real corpus is fast.** Largest document RFC 3261: 2 959 ms full ingest (parse +
  normative + references + commit), 0.65–1.03 s per `requirements()`, 14 ms outline. RFC 1122
  520 ms ingest; RFC 959 462 ms; RFC 768 39 ms.
- **Paging and cursor integrity.** Cursor MACs, binding to query+generation, retarget-on-version-bump
  redirect, and the page-1-only candidate stub with `omitted_on_page` all behave as documented.
  600 requirements fetched in 3 pages with zero duplicates.
- **Schema strictness.** Every out-of-range value is rejected with a named bound, unknown keys
  are rejected by name (`Unrecognized key: "max_outputbyte"`), and `search` with a 2 001-char
  query returns a branchable `LIMIT_EXCEEDED`. The `LIMIT_EXCEEDED` on batch > 10 is correct.
- **Furniture handling on real old RFCs.** RFC 768 and RFC 1122 parse to 11 and 122 sections
  with 38 and 1 094 blocks, `quality: complete` — the 1973-1984 typeset formats are handled.

---

## 5. Summary table

Severity by consequence: data loss or a confidently wrong count is critical; a clear error is fine.

| #   | input                                                                                                                                                            | observed behaviour                                                                                                                                                                                                                                 | hang / lie / error                  | severity                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| C1  | rfc-editor.org returns `200 text/html` (503 page)                                                                                                                | stored as RFC 9001; 2 requirements at `parse_status: complete`, `verify_citation: verified`; `degraded` only on `resolve`                                                                                                                          | **LIE**                             | critical                           |
| C2  | Latin-1 bytes (lone `0xE9`) before a requirement                                                                                                                 | `byte_start` off by 6; `raw.subarray` does not contain the quote; `verify_citation: verified`; snapshot `complete`; "approximate" note unreachable                                                                                                 | **LIE**                             | critical (latent vs live upstream) |
| C3  | 2 000 lines of `MUST`, no terminal punctuation                                                                                                                   | `total_requirements: 1`; `blocks_skipped: 0`, `keyword_bearing_blocks_skipped: 0`; `mentions` 500 of 2 000 with no flag; no warning                                                                                                                | **LIE**                             | critical                           |
| C4  | one 115 KB line, 5 000 sentences                                                                                                                                 | `analyzeNormative` 33 293 ms; 4.6 MB single line > 300 s; quadratic in block length                                                                                                                                                                | **HANG** (ingest/reanalyze)         | critical                           |
| C5  | `read(section, max_output_bytes=64)` on RFC 3261 §20                                                                                                             | `text` 64 chars, `text_verbatim` 4 039 chars, response 18 KiB; `byte_cursor` returned, `offset_bytes` ignored, tail unreachable; 6 real sections affected                                                                                          | **LIE** + limit defeated            | critical                           |
| C6  | 6 000 keyword-bearing blocks                                                                                                                                     | only first 5 000 analysed; `scanned_blocks: 501`; no warning, no cursor, no `limits` entry                                                                                                                                                         | **LIE**                             | critical                           |
| H1  | 5 MB of blank lines                                                                                                                                              | 14 717 ms, all in `isPageFurniture`; linear, no ceiling                                                                                                                                                                                            | **HANG** (ingest)                   | high                               |
| H2  | 10 000 × `1. Introduction`                                                                                                                                       | 10 002 sections, **zero warnings**, 4.5 MB outline, 10 000 unaddressable by number                                                                                                                                                                 | silently wrong                      | high                               |
| H3  | `max_results=199` on `search`; 200 on `references`; 10 on `read.max_output_bytes`; 10 on `context_chars`; 4 on `depth`; 201 on `max_nodes`; 501 on `max_changes` | clamped, `limits.applied` records it, **no warning**; recoverable by cursor for `search`/`references`, final for the rest                                                                                                                          | silent clamp                        | high                               |
| H4  | any call                                                                                                                                                         | `capabilities.limits` advertises `maxRawSliceBytes: 262144` (actual 4 MiB) and `maxCompletionValues: 20`; neither exists in code                                                                                                                   | phantom limit                       | high                               |
| H5  | `requirements()` / `read(outline)` on the real RFC 3261                                                                                                          | 797–1 011 KiB per call; 1 774 KiB with `include_provisional`; 4 588 KiB outline; `max_results=1` returns 1.1 MB; `tools.ts:84` has no cap                                                                                                          | unbounded output                    | high                               |
| H6  | `batch` of 10 `requirements` on a hostile doc                                                                                                                    | 41 497 ms, `status: ok`; no per-request budget or deadline                                                                                                                                                                                         | **HANG**                            | high                               |
| H7  | `\f` at column 30 of a sentence                                                                                                                                  | ships inside `exact_text`, `parse_status: complete`, `verified`, no warning                                                                                                                                                                        | **LIE**                             | high                               |
| H8  | lone CR, no LF                                                                                                                                                   | whole document = 1 line = 1 "sentence"; 2 keywords → 1 requirement at `parse_status: complete`; cause not named                                                                                                                                    | **LIE**                             | high                               |
| M1  | NUL bytes mid-sentence                                                                                                                                           | silently changes the split; no warning                                                                                                                                                                                                             | silent                              | medium                             |
| M2  | table, 300 `MUST NOT` cells                                                                                                                                      | 0 requirements, correctly warned — but "1 block" stands for 300 statements, and the candidate list has 1 row                                                                                                                                       | undercount                          | medium                             |
| M3  | TOC promises 5 000, body has 3                                                                                                                                   | `toc_sections_without_a_heading:4,5,…,23` — 20 numbers for a **4 997** shortfall, no total, no "…and more", and `quality: complete` because the warning is neither `no_*` nor `toc_unterminated`; the whole warning is invisible outside `resolve` | silent truncation                   | medium                             |
| M4  | 5 000-char heading                                                                                                                                               | section lost, disclosed only in the invisible `snapshot.warnings`                                                                                                                                                                                  | silent                              | medium                             |
| M5  | 5 000 indented subsections                                                                                                                                       | 4 194 ms ingest, 5 000 sections found — works; RFC 9110 takes this path 257×                                                                                                                                                                       | fine, slow                          | medium                             |
| M6  | UTF-8 BOM (live on RFC 9110)                                                                                                                                     | `source_starts_with_bom` recorded, offsets correct, never surfaced                                                                                                                                                                                 | fine, hidden                        | medium                             |
| M7  | 100 002-line document                                                                                                                                            | 4 588 KiB outline, `truncated: false`, no section-count limit                                                                                                                                                                                      | unbounded output                    | medium                             |
| M8  | PNG header / gzip magic                                                                                                                                          | `degraded` in the row, zero-count warning raised, no "not text" signal                                                                                                                                                                             | honest-ish                          | medium                             |
| M9  | 4 000 unclosed-quote lines                                                                                                                                       | 4 000 requirements, 3 330 ms                                                                                                                                                                                                                       | correct                             | low                                |
| M10 | `raw_slice` page boundary inside a multi-byte char                                                                                                               | `.toString("utf8")` instead of `truncateBytes`; U+FFFD at each boundary, unflagged                                                                                                                                                                 | latent corruption                   | medium                             |
| M11 | `requirements` pagination, candidate stub                                                                                                                        | 3 pages / 600 rows, `omitted_on_page` correct, cursors MAC-bound                                                                                                                                                                                   | correct                             | low                                |
| M12 | `search(ensure_rfcs=[20], ensure_top_catalog_hits=20)`                                                                                                           | up to 40 ingests per call; × 10 in a batch = 200                                                                                                                                                                                                   | cost amplifier                      | medium                             |
| M13 | CLI human output                                                                                                                                                 | formatters never print `envelope.warnings`                                                                                                                                                                                                         | all warnings invisible to operators | medium                             |
| —   | empty / 1 char / 1 newline / whitespace / 10 000 blanks / 5 MB blanks / front-matter-only / body-no-sections / 1 enormous line                                   | `degraded` with a `no_*` cause, 0 sections, 0 requirements, a zero-count warning, honest `NOT_FOUND` on section reads                                                                                                                              | **error correctly**                 | none                               |
| —   | table with `MUST NOT` + 4 000 chars/cell                                                                                                                         | `table`, skipped, counted, warned, 500 candidate rows recovered                                                                                                                                                                                    | **correct**                         | none                               |
| —   | limits at/over/under across 10 parameters                                                                                                                        | schemas reject with named bounds; clamp values recorded in `limits.applied`; batch > 10 → `LIMIT_EXCEEDED`; query > 2 000 → `LIMIT_EXCEEDED`                                                                                                       | **error correctly** (modulo H3/H4)  | none                               |
| —   | real corpus: RFC 3261 / 9110 / 1122 / 2822 / 959 / 768                                                                                                           | 39–2 959 ms ingest, 3 ms–1.03 s per call, `quality: complete`                                                                                                                                                                                      | **correct**                         | none                               |
| —   | 4 000 unclosed quotes, 5 000 indented subsections, 900-deep nesting, 10 000 sections, TOC/body mismatch                                                          | correct or correctly warned; 1.5–11.3 s ingest                                                                                                                                                                                                     | fine (ingest cost)                  | low                                |

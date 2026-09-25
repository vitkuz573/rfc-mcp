# Contributing to rfc-mcp

Thanks for considering a contribution. This project makes a small number of promises about
correctness; a change that breaks one of them is not a stylistic difference, it is a defect.

## The promises

1. **Analysis runs only on immutable, content-addressed snapshots.** New data produces new
   snapshots; it never rewrites an existing one.
2. **Every derived fact is citable and verifiable** against the stored bytes.
3. **Uncertainty is reported, not repaired.** Unresolved references, degraded parses, truncated
   results and offline misses appear in `warnings` / `status`; they are never smoothed over.
4. **The model-visible surface is read-only.** Ingestion and re-analysis are CLI operations.
5. **No silent egress.** Only the three allow-listed IETF hosts are reachable, and no
   user-supplied URL ever reaches `fetch`.
6. **RFC text is untrusted data.** It is quoted, never obeyed.

## Getting started

```sh
npm ci
npm run verify      # format check + typecheck + tests + build
```

Node.js ≥ 24 is required (the store uses the built-in `node:sqlite`). There is no native build
step and no database server to install.

## Workflow

1. Open an issue first for anything beyond a small fix, so the design can be agreed before the
   code is written.
2. Branch from `main` with a descriptive name (`fix/byte-offsets-bom`).
3. Keep the change focused. Unrelated refactors make review harder and hide regressions.
4. Add or update tests. Every bug fix needs a regression test that fails without the fix.
5. Run `npm run verify` before pushing.
6. Write a pull request that explains _what_ changed, _why_, and _how it was verified_. If a
   parser or extractor rule changed, say so and bump the corresponding version string — snapshot
   identity depends on it.

## Code style

- TypeScript `strict`; no `any` in exported signatures; no unchecked casts that hide real type
  errors.
- Prettier owns formatting: `npm run format`. Do not hand-format around it.
- Comments explain **why**, not **what**. The code already says what.
- Prefer explicit, boring code over clever abstraction. This server is the evidence layer; it
  should be easy to audit.
- Errors are typed: add codes to `src/core/errors.ts` and document them in
  `docs/CONTRACT.md` rather than throwing ad-hoc strings.

## Changing the parser or the extractor

Both are versioned (`config.ts`: `parserVersion`, `extractorVersion`) and both are part of the
snapshot hash.

1. Change the code.
2. Bump the version string — a patch bump for a bug fix, a minor bump for a behaviour change.
3. Add tests that pin the new behaviour, including the previous behaviour if it was a bug.
4. Ask the maintainer to run `rfc-mcp reanalyze <rfc>…` for the local corpus, or re-ingest.

Without step 2 the corpus would keep serving analysis produced by different rules under the same
snapshot id, which is exactly the failure mode this design exists to prevent.

## Tests

- `tests/text-parser.test.ts` — section tree, exact round-trip offsets, determinism, BOM and
  multi-byte content, RFC 2119 ambiguity
- `tests/normative.test.ts` — all eleven keywords, longest-match, case sensitivity, code
  exclusion, clause structure, citation stability
- `tests/xml.test.ts` — DTD rejection, entity non-expansion, depth limits, offsets, outline
- `tests/http.test.ts` — allowlist, ETag revalidation, retry, stale-on-error, size cap,
  cancellation
- `tests/service.test.ts` — end-to-end over a fake upstream: resolve, read, search, requirements,
  references, errata, diff, batch, offline behaviour, privacy
- `tests/protocol.test.ts` — black-box stdio JSON-RPC for both protocol eras

The protocol test spawns the built `dist/index.js`. Run `npm run build` before it, or use
`npm run verify`.

## Adding a tool

A new tool must be read-only, bounded, cancellable, and return the standard envelope. Register it
in `src/mcp/tools.ts` with a zod `inputSchema` and an `outputSchema`, add it to the list in
`service.capabilities()`, extend `docs/CONTRACT.md`, and add a case to `tests/protocol.test.ts`
(which asserts the exact tool list). A tool that can mutate the corpus does not belong here.

## Reporting bugs

Open an issue with the RFC number, the tool call, the returned envelope, and what you expected.
For a citation problem, the `provenance.observed_at` and `index_generation` fields make the
report reproducible.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

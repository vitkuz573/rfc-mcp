# Licensing

Two different things live in this repository, and they are licensed differently.

## 1. The code — Apache License 2.0

Everything in `src/`, `tests/`, `docs/`, `scripts/` and the repository's own configuration is
licensed under the [Apache License, Version 2.0](../LICENSE), the full text of which is in
`LICENSE`. That includes the parser, the requirement extractor, the citation machinery, the
storage layer, the CLI and the documentation.

## 2. RFC content — IETF Trust Legal Provisions

Text of IETF RFCs retrieved by this software is **not** covered by the Apache License. It is
reproduced **unmodified** from the [RFC Editor](https://www.rfc-editor.org/) and remains subject
to the IETF Trust's Legal Provisions:

- TLP: <https://trustee.ietf.org/documents/trust-legal-provisions/tlp-5/>
- RFC-use guidance: <https://www.rfc-editor.org/series/rfc-use/>

In short, TLP permits copying, publishing, displaying and distributing IETF documents in full
and without modification, and reproducing unmodified portions with attribution. It does **not**
grant the right to modify an RFC, to create derivative works outside the IETF Standards Process,
or to represent a modified text as an RFC.

## How this project complies

- **The server never rewrites RFC prose.** `rfc_read` and `rfc_source` return the published
  bytes; excerpts come from the file, with copyright notices intact.
- **Attribution is structural.** Every response carries `provenance.source_urls` pointing at the
  canonical RFC Editor URL, and every snapshot records the byte range and line numbers a quote
  occupies.
- **Summaries are the host's responsibility.** The LLM using this server may explain an RFC, but
  the server never restates it; that separation keeps the licensed text and the interpretation
  clearly distinguishable.
- **Errata are an overlay.** Errata are published independently by the RFC Editor and are never
  merged into a snapshot's publication text. Displaying an erratum is displaying a separate
  record, not a modified RFC.

## Trademarks

Nothing here grants rights to the IETF name or logo. This project is not affiliated with,
endorsed by, or sponsored by the IETF, and it must not be presented as if it were.

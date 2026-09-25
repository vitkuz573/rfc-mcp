# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

The project is pre-1.0: the public contract (`ietf-rfc/1`) and the parser/extractor version
strings are expected to change, but security fixes are applied to the latest release.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: go to the repository's **Security** tab → **Report a
vulnerability**. If that is unavailable, contact the maintainer directly.

Include:

- what you observed and how to reproduce it;
- the affected component (`upstream/http`, `parse/xml`, `store/database`, `mcp/*`, …);
- the tool call and full returned envelope if it involves the MCP surface;
- your Node.js version and OS.

You can expect an acknowledgement within 72 hours and an assessment within 7 days. Fixes for
confirmed issues are released as soon as they are ready, and the advisory is published with
credit unless you prefer otherwise.

## Threat model in brief

This server runs locally over stdio, is read-only, and reaches exactly three hosts:
`www.rfc-editor.org`, `errata.rfc-editor.org`, `datatracker.ietf.org`.

It therefore assumes:

- **The host process is trusted.** A compromised host can already read the process's memory and
  files; this is out of scope.
- **RFC content is hostile.** Documents are untrusted input. The server treats them as data:
  they are never executed, never used to build file paths, and never interpreted as instructions.
  Prompt injection is a host/LLM concern; this server's job is to keep the text quotable and
  bounded, not to defend the model.
- **No secrets are managed.** The server has no authentication surface, stores no credentials, and
  writes only to `RFC_MCP_DATA_DIR`.

Already implemented, and what each measure is for:

| Control                                                                                               | Purpose                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Host allowlist + HTTPS-only, enforced in `assertAllowedUrl`                                           | Prevents SSRF and arbitrary egress, including `file://`, loopback and cloud metadata addresses |
| No user-supplied URLs                                                                                 | Callers pass RFC numbers and enum values; URLs are constructed server-side                     |
| Bounded response size, timeout, per-host concurrency, retry budget                                    | Bounds resource use under a hostile or slow upstream                                           |
| ETag revalidation, stale-on-error with explicit warning                                               | Prevents a failing upstream from silently substituting data                                    |
| XML hardening: DTD and entity declarations rejected, XInclude never resolved, depth/node/text budgets | Prevents XXE, entity expansion and parser denial of service                                    |
| Bounded query grammar; FTS5 input is always quoted literals                                           | Prevents query injection and unbounded computation                                             |
| Bounded output, graph, batch, diff and cursor sizes                                                   | Prevents context flooding and unbounded memory growth                                          |
| Integrity-bound cursors with an HMAC and a generation binding                                         | Prevents cursor forgery and silent skips across corpus changes                                 |
| Snapshot content hash verified before citation checks                                                 | Detects corrupted or substituted local data                                                    |
| Author emails stripped at the source adapter boundary                                                 | Reduces personal data exposure                                                                 |
| Structured logs with secret and document-text redaction                                               | Prevents leakage through logs                                                                  |
| Read-only tool surface, CLI-only corpus maintenance                                                   | Prevents a model from mutating the evidence it reasons about                                   |
| Corpus directory created with mode `0700`                                                             | Prevents other local users from reading the cache                                              |

## Non-goals

- Defending against a malicious _host_ (for example a fake `rfc-mcp` binary placed earlier in
  `PATH`).
- Confidentiality of RFC content — it is public by definition.
- Access control inside the corpus database; it is a single-user cache.

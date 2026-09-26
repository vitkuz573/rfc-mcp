import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig, parseRfcNumber, rfcFileStem } from "../src/core/config.js";
import { ERRATA_STATUSES, canonicalErrataStatus, errataStatusFilter } from "../src/core/types.js";

const VERSIONS = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "contract-versions.json"), "utf8")) as {
  server: string;
  parser: string;
  extractor: string;
};

const PACKAGE = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
  version: string;
};

describe("version coupling", () => {
  /**
   * A snapshot id hashes the parser and extractor versions, so bumping either retires
   * every id a client holds. `server.version` is the only signal a client gets that
   * this happened, and that signal was promised and then not kept: the parser moved
   * 1.5.0 -> 1.6.0 under an unchanged 0.2.0. This fails instead.
   */
  it("moves the server version whenever a derivation version moves", () => {
    const config = loadConfig();
    expect(VERSIONS.server).toBe(PACKAGE.version);
    expect(config.parserVersion).toBe(VERSIONS.parser);
    expect(config.extractorVersion).toBe(VERSIONS.extractor);
    // The version the MCP handshake reports is the one a client compares against.
    expect(config.version).toBe(VERSIONS.server);
  });
});

describe("errata status normalization", () => {
  it("maps every display spelling onto the canonical slug", () => {
    expect(canonicalErrataStatus("Held for Document Update")).toBe("held_for_document_update");
    expect(canonicalErrataStatus("held-for-document-update")).toBe("held_for_document_update");
    expect(canonicalErrataStatus("VERIFIED")).toBe("verified");
    expect(canonicalErrataStatus("nonsense")).toBe("unknown");
    expect(canonicalErrataStatus(null)).toBe("unknown");
  });

  it("treats 'any' as no filter rather than as a literal status", () => {
    // `any` reached SQL verbatim once and matched nothing, so the documented value
    // for "every status" returned an empty list.
    for (const spelling of ["any", "ANY", "", null, undefined]) {
      expect(errataStatusFilter(spelling as string | null)).toBeNull();
    }
    expect(errataStatusFilter("held for document update")?.parameter).toBe("held_for_document_update");
    expect(errataStatusFilter("held_for_document_update")?.clause).toContain("replace");
  });

  it("keeps the canonical list and the normalizer in agreement", () => {
    for (const status of ERRATA_STATUSES) expect(canonicalErrataStatus(status)).toBe(status);
  });
});

describe("RFC identifiers", () => {
  it("accepts the spellings a caller actually types", () => {
    expect(parseRfcNumber(9110)).toBe(9110);
    expect(parseRfcNumber("9110")).toBe(9110);
    expect(parseRfcNumber("RFC9110")).toBe(9110);
    expect(parseRfcNumber("rfc 9110")).toBe(9110);
  });

  it("rejects what is not an RFC number", () => {
    for (const bad of [0, -1, 100_000, "09110", "abc", ""]) {
      expect(() => parseRfcNumber(bad as string | number), String(bad)).toThrow();
    }
  });

  it("names the file the publication actually lives in", () => {
    expect(rfcFileStem(1035)).toBe("rfc1035");
  });
});

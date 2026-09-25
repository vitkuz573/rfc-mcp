/**
 * Adapters for the official IETF primary sources.
 *
 * Source priority (per research against rfc-editor.org and datatracker.ietf.org):
 *  1. static publication files and the RFC Editor index for document content;
 *  2. `api/v1/rfc-common/<n>.json` for structured metadata;
 *  3. Datatracker `doc.json` and `relateddocument` for process metadata and
 *     relations that the publication files do not carry;
 *  4. `rfc-html/<n>.json` only when errata are explicitly requested.
 *
 * Undocumented internals (the RFC Editor front-end search backend) and
 * unofficial mirrors are never used. Author email addresses are stripped at
 * the boundary: they are personal data and add nothing to a standards lookup.
 */

import { RfcMcpError } from "../core/errors.js";
import type {
  Author,
  CatalogRecord,
  DocumentRef,
  Erratum,
  HistoryEntry,
  NamedRef,
  SubseriesRef,
} from "../core/types.js";
import { sha256Hex } from "../core/util.js";
import { findChildren, findRoot, parseXml, textContent } from "../parse/xml.js";
import { HttpClient } from "./http.js";

const RFC_EDITOR = "https://www.rfc-editor.org";
const DATATRACKER = "https://datatracker.ietf.org";

/* -------------------------------------------------------------------------- */
/* Payload shapes                                                              */
/* -------------------------------------------------------------------------- */

interface MiniIndexEntry {
  number?: unknown;
  title?: unknown;
  published?: unknown;
  authors?: unknown;
  formats?: unknown;
  obsoletes?: unknown;
  obsoleted_by?: unknown;
  updates?: unknown;
  updated_by?: unknown;
  status?: unknown;
  stream?: unknown;
  identifiers?: unknown;
  subseries?: unknown;
  abstract?: unknown;
  group?: unknown;
  area?: unknown;
  keywords?: unknown;
  pages?: unknown;
  doi?: unknown;
}

interface RfcCommonPayload {
  number?: unknown;
  title?: unknown;
  abstract?: unknown;
  published?: unknown;
  pages?: unknown;
  status?: unknown;
  stream?: unknown;
  group?: unknown;
  area?: unknown;
  keywords?: unknown;
  authors?: unknown;
  obsoletes?: unknown;
  obsoleted_by?: unknown;
  updates?: unknown;
  updated_by?: unknown;
  subseries?: unknown;
  identifiers?: unknown;
  formats?: unknown;
  doi?: unknown;
}

interface DocumentJsonPayload {
  doc_id?: unknown;
  title?: unknown;
  authors?: unknown;
  format?: unknown;
  pub_status?: unknown;
  status?: unknown;
  source?: unknown;
  abstract?: unknown;
  pub_date?: unknown;
  keywords?: unknown;
  obsoletes?: unknown;
  obsoleted_by?: unknown;
  updates?: unknown;
  updated_by?: unknown;
  see_also?: unknown;
  doi?: unknown;
}

interface DocJsonPayload {
  name?: unknown;
  title?: unknown;
  abstract?: unknown;
  time?: unknown;
  group?: unknown;
  state?: unknown;
  std_level?: unknown;
  intended_std_level?: unknown;
  authors?: unknown;
  rev_history?: unknown;
  stream?: unknown;
  pages?: unknown;
  shepherd?: unknown;
  ad?: unknown;
}

interface RelationsPayload {
  meta?: { total_count?: unknown; next?: unknown; limit?: unknown };
  objects?: unknown;
}

interface RfcHtmlPayload {
  rfc?: unknown;
  errataList?: unknown;
}

export interface UpstreamAsset {
  readonly format: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly body: Buffer;
  readonly retrievedAt: string;
  readonly sourceUrl: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly warnings: readonly string[];
}

export interface UpstreamMetadata {
  readonly record: CatalogRecord;
  readonly warnings: readonly string[];
  readonly sourceUrl: string;
  readonly observations: { readonly source: string; readonly url: string; readonly observedAt: string }[];
}

export interface RelationObservation {
  readonly rfc: number;
  readonly relation: string;
  readonly direction: "outgoing" | "incoming";
  readonly evidence: { readonly source: string; readonly url: string | null; readonly observed_at: string } | null;
}

/* -------------------------------------------------------------------------- */

export class RfcEditorSource {
  constructor(
    private readonly http: HttpClient,
    private readonly options: { indexTimeoutMs?: number } = {},
  ) {}

  async fetchMiniIndex(
    signal?: AbortSignal,
  ): Promise<{ entries: MiniIndexEntry[]; sourceUrl: string; warnings: string[] }> {
    const url = `${RFC_EDITOR}/api/v1/rfc-mini-index.json`;
    const { value, result } = await this.http.getJson<{ miniIndex?: unknown }>({
      url,
      label: "rfc-mini-index",
      accept: ["application/json"],
      // The catalog is ~7 MB and the RFC Editor is occasionally slow for it.
      timeoutMs: this.options.indexTimeoutMs ?? 180_000,
      maxBytes: 32 * 1024 * 1024,
      signal,
    });
    const entries = Array.isArray(value.miniIndex) ? (value.miniIndex as MiniIndexEntry[]) : [];
    if (entries.length === 0) {
      throw new RfcMcpError("UPSTREAM_CONTRACT", "RFC mini index did not contain any entries", {
        details: { url },
      });
    }
    return {
      entries,
      sourceUrl: result.url,
      warnings: result.warnings as string[],
    };
  }

  async fetchCommonMetadata(
    rfc: number,
    signal?: AbortSignal,
    options: { revalidate?: boolean } = {},
  ): Promise<UpstreamMetadata> {
    const url = `${RFC_EDITOR}/api/v1/rfc-common/${rfc}.json`;
    const { value, result } = await this.http.getJson<RfcCommonPayload>({
      url,
      label: "rfc-common",
      accept: ["application/json"],
      signal,
      revalidate: options.revalidate,
    });
    const observations = [{ source: "rfc_editor", url: result.url, observedAt: result.retrievedAt }];
    return {
      record: normalizeCommon(rfc, value, result.retrievedAt, result.url),
      warnings: result.warnings as string[],
      sourceUrl: result.url,
      observations,
    };
  }

  async fetchDocumentJson(
    rfc: number,
    signal?: AbortSignal,
    options: { revalidate?: boolean } = {},
  ): Promise<{ payload: DocumentJsonPayload; sourceUrl: string; warnings: string[] }> {
    const url = `${RFC_EDITOR}/rfc/rfc${rfc}.json`;
    const { value, result } = await this.http.getJson<DocumentJsonPayload>({
      url,
      label: "rfc-json",
      accept: ["application/json"],
      signal,
      revalidate: options.revalidate,
    });
    return { payload: value, sourceUrl: result.url, warnings: result.warnings as string[] };
  }

  async fetchPublication(
    rfc: number,
    format: "txt" | "xml" | "html" | "pdf",
    signal?: AbortSignal,
    options: { revalidate?: boolean } = {},
  ): Promise<UpstreamAsset> {
    const url = `${RFC_EDITOR}/rfc/rfc${rfc}.${format}`;
    const accept =
      format === "txt"
        ? ["text/plain"]
        : format === "xml"
          ? ["application/xml", "text/xml"]
          : format === "html"
            ? ["text/html"]
            : ["application/pdf"];
    const result = await this.http.get({
      url,
      label: `rfc-${format}`,
      accept,
      maxBytes: format === "pdf" ? 32 * 1024 * 1024 : 16 * 1024 * 1024,
      allowNotFound: false,
      signal,
      revalidate: options.revalidate,
    });
    return {
      format,
      contentType: result.contentType ?? guessContentType(format),
      bytes: result.body.byteLength,
      sha256: `sha256:${sha256Hex(result.body)}`,
      body: result.body,
      retrievedAt: result.retrievedAt,
      sourceUrl: result.url,
      etag: result.etag,
      lastModified: result.lastModified,
      warnings: result.warnings,
    };
  }

  async fetchErrata(
    rfc: number,
    signal?: AbortSignal,
  ): Promise<{ errata: Erratum[]; sourceUrl: string; warnings: string[] }> {
    const url = `${RFC_EDITOR}/api/v1/rfc-html/${rfc}.json`;
    const { value, result } = await this.http.getJson<RfcHtmlPayload>({
      url,
      label: "rfc-html-errata",
      accept: ["application/json"],
      maxBytes: 24 * 1024 * 1024,
      signal,
    });
    const list = Array.isArray(value.errataList) ? (value.errataList as Record<string, unknown>[]) : [];
    const errata: Erratum[] = list.map((item) => normalizeErratum(rfc, item));
    return { errata, sourceUrl: result.url, warnings: result.warnings as string[] };
  }
}

export class DatatrackerSource {
  constructor(private readonly http: HttpClient) {}

  async fetchDocJson(
    rfc: number,
    signal?: AbortSignal,
  ): Promise<{ payload: DocJsonPayload; sourceUrl: string; warnings: string[] }> {
    const url = `${DATATRACKER}/doc/rfc${rfc}/doc.json`;
    const { value, result } = await this.http.getJson<DocJsonPayload>({
      url,
      label: "datatracker-doc",
      accept: ["application/json"],
      signal,
    });
    return { payload: value, sourceUrl: result.url, warnings: result.warnings as string[] };
  }

  async fetchRelations(
    rfc: number,
    options: { direction: "outgoing" | "incoming"; limit: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<{ relations: RelationObservation[]; total: number; sourceUrl: string; warnings: string[] }> {
    const query = new URLSearchParams({ format: "json", limit: String(options.limit) });
    if (options.direction === "outgoing") query.set("source__name", `rfc${rfc}`);
    else query.set("target__name", `rfc${rfc}`);
    if (options.offset) query.set("offset", String(options.offset));
    const url = `${DATATRACKER}/api/v1/doc/relateddocument/?${query.toString()}`;
    const { value, result } = await this.http.getJson<RelationsPayload>({
      url,
      label: "datatracker-relations",
      accept: ["application/json"],
      maxBytes: 4 * 1024 * 1024,
      signal,
    });
    const objects = Array.isArray(value.objects) ? (value.objects as Record<string, unknown>[]) : [];
    const relations: RelationObservation[] = [];
    for (const object of objects) {
      const relation = slugFromUri(asString(object.relationship));
      const sourceName = nameFromUri(asString(object.source));
      const targetName = nameFromUri(asString(object.target));
      const alias = asString(object.originaltargetaliasname);
      const otherName = options.direction === "outgoing" ? targetName : sourceName;
      const otherAlias = options.direction === "outgoing" ? alias : null;
      const rfcMatch = /^(?:draft-.*-|rfc)(\d+)$/u.exec(otherAlias ?? otherName ?? "");
      if (!rfcMatch) continue;
      relations.push({
        rfc: Number.parseInt(rfcMatch[1]!, 10),
        relation,
        direction: options.direction,
        evidence: {
          source: "datatracker",
          url: asString(object.resource_uri) ? new URL(asString(object.resource_uri)!, DATATRACKER).toString() : null,
          observed_at: result.retrievedAt,
        },
      });
    }
    const total = typeof value.meta?.total_count === "number" ? value.meta.total_count : relations.length;
    return { relations, total, sourceUrl: result.url, warnings: result.warnings as string[] };
  }

  async fetchHistory(
    rfc: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ entries: HistoryEntry[]; sourceUrl: string; warnings: string[] }> {
    const url = `${DATATRACKER}/feed/document-changes/rfc${rfc}/`;
    const result = await this.http.get({
      url,
      label: "datatracker-history",
      accept: ["application/atom+xml", "application/xml"],
      maxBytes: 4 * 1024 * 1024,
      signal,
    });
    const source = result.body.toString("utf8");
    const roots = parseXml(source);
    const feed = findRoot(roots, "feed");
    if (!feed) {
      throw new RfcMcpError("UPSTREAM_CONTRACT", "History feed did not contain an Atom <feed> element", {
        details: { url },
      });
    }
    const entries: HistoryEntry[] = findChildren(feed, "entry")
      .slice(0, limit)
      .map((entry) => {
        const title = textContent(findChildren(entry, "title")[0]!) || "";
        const summaryNode = findChildren(entry, "summary")[0];
        const idNode = findChildren(entry, "id")[0];
        const publishedNode = findChildren(entry, "published")[0] ?? findChildren(entry, "updated")[0];
        const authorNode = findChildren(entry, "author")[0];
        const linkNode =
          findChildren(entry, "link").find((link) => link.attrs.rel === "alternate") ?? findChildren(entry, "link")[0];
        return {
          id: idNode ? textContent(idNode) : `${rfc}-${title.slice(0, 32)}`,
          rfc,
          title,
          summary: summaryNode ? textContent(summaryNode).replace(/\s+/gu, " ").trim() : "",
          published_at: publishedNode ? textContent(publishedNode).trim() : null,
          author: authorNode ? textContent(findChildren(authorNode, "name")[0] ?? authorNode).trim() : null,
          url: linkNode?.attrs.href ?? `https://datatracker.ietf.org/doc/rfc${rfc}/history/`,
        };
      });
    return { entries, sourceUrl: result.url, warnings: result.warnings as string[] };
  }

  async fetchBibtex(rfc: number, signal?: AbortSignal): Promise<string | null> {
    const url = `${DATATRACKER}/doc/rfc${rfc}/bibtex/`;
    const result = await this.http.get({
      url,
      label: "datatracker-bibtex",
      accept: ["text/plain"],
      maxBytes: 512 * 1024,
      allowNotFound: true,
      signal,
    });
    if (result.status === 404) return null;
    return result.body.toString("utf8");
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

export function normalizeCommon(
  rfc: number,
  payload: RfcCommonPayload,
  observedAt: string,
  sourceUrl: string,
): CatalogRecord {
  const identifiers = normalizeIdentifiers(payload.identifiers);
  return {
    document_id: `rfc-${rfc}`,
    rfc,
    title: asString(payload.title) ?? `RFC ${rfc}`,
    abstract: asString(payload.abstract) ?? null,
    published: asString(payload.published) ?? null,
    pages: asNumber(payload.pages),
    status: normalizeNamed(payload.status),
    stream: normalizeNamed(payload.stream),
    area: normalizeNamed(payload.area),
    group: normalizeNamed(payload.group),
    keywords: normalizeStringArray(payload.keywords),
    authors: normalizeAuthors(payload.authors),
    obsoletes: normalizeNumbers(payload.obsoletes),
    obsoleted_by: normalizeNumbers(payload.obsoleted_by),
    updates: normalizeNumbers(payload.updates),
    updated_by: normalizeNumbers(payload.updated_by),
    subseries: normalizeSubseries(payload.subseries),
    identifiers,
    formats: normalizeFormats(payload.formats),
    doi:
      identifiers.find((identifier) => identifier.type.toLowerCase() === "doi")?.value ?? asString(payload.doi) ?? null,
    canonical_url: `${RFC_EDITOR}/info/rfc${rfc}/`,
    source_url: sourceUrl,
    observed_at: observedAt,
    content_hash: "",
  };
}

export function mergeDocumentJson(record: CatalogRecord, payload: DocumentJsonPayload): CatalogRecord {
  const identifiers =
    record.identifiers.length > 0
      ? record.identifiers
      : asString(payload.doi)
        ? [{ type: "doi", value: asString(payload.doi)! }]
        : [];
  return {
    ...record,
    title: asString(payload.title) ?? record.title,
    abstract: asString(payload.abstract) ?? record.abstract,
    authors: record.authors.length > 0 ? record.authors : normalizeAuthors(payload.authors),
    keywords: record.keywords.length > 0 ? record.keywords : normalizeStringArray(payload.keywords),
    obsoletes: record.obsoletes.length > 0 ? record.obsoletes : normalizeNumbers(payload.obsoletes),
    obsoleted_by: record.obsoleted_by.length > 0 ? record.obsoleted_by : normalizeNumbers(payload.obsoleted_by),
    updates: record.updates.length > 0 ? record.updates : normalizeNumbers(payload.updates),
    updated_by: record.updated_by.length > 0 ? record.updated_by : normalizeNumbers(payload.updated_by),
    status: record.status ?? normalizeNamed({ slug: asString(payload.pub_status), name: asString(payload.status) }),
    doi: record.doi ?? identifiers.find((identifier) => identifier.type.toLowerCase() === "doi")?.value ?? null,
    identifiers,
  };
}

export function mergeDocJson(record: CatalogRecord, payload: DocJsonPayload): CatalogRecord {
  const group = normalizeNamed(payload.group);
  const statusSlug = asString(payload.std_level) ?? asString(payload.intended_std_level) ?? asString(payload.state);
  return {
    ...record,
    title: asString(payload.title) ?? record.title,
    abstract: asString(payload.abstract) ?? record.abstract,
    group: record.group ?? group,
    status: record.status ?? (statusSlug ? { name: statusSlug } : null),
    authors: record.authors.length > 0 ? record.authors : normalizeAuthors(payload.authors),
    pages: record.pages ?? asNumber(payload.pages),
  };
}

function normalizeErratum(rfc: number, item: Record<string, unknown>): Erratum {
  const id = asString(item.errata_id) ?? asString(item["errata-id"]) ?? "unknown";
  return {
    errata_id: id,
    rfc,
    status: (asString(item.errata_status_code) ?? asString(item.status) ?? "unknown").toLowerCase(),
    type: asString(item.errata_type_code) ?? asString(item.type),
    section: asString(item.section),
    original_text: asString(item.orig_text) ?? asString(item.original_text),
    corrected_text: asString(item.correct_text) ?? asString(item.corrected_text),
    notes: asString(item.notes),
    submitted_at: asString(item.submit_date),
    updated_at: asString(item.update_date),
    url: `https://errata.rfc-editor.org/eid${id}`,
  };
}

function normalizeNamed(value: unknown): NamedRef | null {
  if (!value || typeof value !== "object") {
    const name = asString(value);
    return name ? { name } : null;
  }
  const record = value as Record<string, unknown>;
  const name = asString(record.name) ?? asString(record.slug) ?? asString(record.titlepage_name);
  if (!name) return null;
  const slug = asString(record.slug);
  const description = asString(record.description);
  const acronym = asString(record.acronym);
  const type = asString(record.type);
  return {
    name,
    ...(slug ? { slug } : {}),
    ...(description ? { description } : {}),
    ...(acronym ? { acronym } : {}),
    ...(type ? { type } : {}),
  };
}

function normalizeAuthors(value: unknown): Author[] {
  if (!Array.isArray(value)) return [];
  const out: Author[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ name: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = asString(record.titlepage_name) ?? asString(record.name) ?? asString(record.fullname);
    if (!name) continue;
    const affiliation = asString(record.affiliation) ?? asString(record.organization);
    const isEditor = record.is_editor === true || record.role === "editor";
    out.push({
      name,
      ...(affiliation ? { affiliation } : {}),
      ...(isEditor ? { is_editor: true } : {}),
    });
  }
  return out;
}

function normalizeIdentifiers(value: unknown): { type: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { type: string; value: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = asString(record.type);
    const identifier = asString(record.value);
    if (type && identifier) out.push({ type, value: identifier });
  }
  return out;
}

function normalizeSubseries(value: unknown): SubseriesRef[] {
  if (!Array.isArray(value)) return [];
  const out: SubseriesRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = asString(record.type);
    const number = asNumber(record.number);
    if (!type || number === null) continue;
    out.push({ type, number, label: `${type.toUpperCase()} ${number}` });
  }
  return out;
}

function normalizeFormats(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item === "string") {
      out.add(item.toLowerCase().replace("text", "txt"));
      continue;
    }
    if (item && typeof item === "object") {
      const format = asString((item as Record<string, unknown>).format);
      if (format) out.add(format.toLowerCase());
    }
  }
  return [...out].sort();
}

function normalizeNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) out.add(item);
    else if (typeof item === "string") {
      const match = /(\d{1,5})/u.exec(item);
      if (match) out.add(Number.parseInt(match[1]!, 10));
    } else if (item && typeof item === "object") {
      const nested = asNumber((item as Record<string, unknown>).number);
      if (nested !== null) out.add(nested);
      else {
        const name =
          asString((item as Record<string, unknown>).name) ?? asString((item as Record<string, unknown>).doc_id);
        const match = name ? /(\d{1,5})/u.exec(name) : null;
        if (match) out.add(Number.parseInt(match[1]!, 10));
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

export function documentRef(number: number, title: string | null | undefined): DocumentRef {
  return { number, title: title ?? `RFC ${number}` };
}

function slugFromUri(uri: string | null): string {
  if (!uri) return "unknown";
  const match = /\/([a-z0-9-]+)\/$/iu.exec(uri);
  return match ? match[1]! : uri;
}

function nameFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const match = /\/([^/]+)\/$/u.exec(uri);
  return match ? match[1]! : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function guessContentType(format: string): string {
  switch (format) {
    case "txt":
      return "text/plain";
    case "xml":
      return "application/rfc+xml";
    case "html":
      return "text/html";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

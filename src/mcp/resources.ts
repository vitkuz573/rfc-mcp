/**
 * Resource surface.
 *
 * Resources are application-controlled views over the same immutable data the
 * tools return. Every content URI is snapshot-addressed: it never changes when
 * the corpus is re-synced, and a new snapshot gets a new URI.
 *
 *   rfc://index/status
 *   rfc://catalog/manifest
 *   rfc://snapshot/{snapshot_id}/metadata
 *   rfc://snapshot/{snapshot_id}/provenance
 *   rfc://snapshot/{snapshot_id}/outline
 *   rfc://snapshot/{snapshot_id}/sections/{section_id}
 *   rfc://snapshot/{snapshot_id}/blocks/{block_id}
 *   rfc://snapshot/{snapshot_id}/requirements/{requirement_id}
 *   rfc://snapshot/{snapshot_id}/references/{reference_id}
 *   rfc://snapshot/{snapshot_id}/citations/{citation_id}
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";

import { isRfcMcpError, RfcMcpError } from "../core/errors.js";
import { shortHash } from "../core/util.js";
import type { RfcService } from "../service/rfcService.js";

const SNAPSHOT_PATTERN = "snp_[0-9a-f]{24}";
const ID_PATTERN = "[A-Za-z0-9_-]{1,96}";

function notFound(uri: URL, reason: string): RfcMcpError {
  return new RfcMcpError("NOT_FOUND", reason, { details: { uri: uri.toString() }, retryable: false });
}

export function registerResources(server: McpServer, service: RfcService): void {
  server.registerResource(
    "index-status",
    "rfc://index/status",
    {
      title: "Corpus status",
      description: "Local corpus health, index generation, parser versions and offline mode.",
      mimeType: "application/json",
    },
    async (uri) => {
      const envelope = await service.status();
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(envelope.data),
          },
        ],
      };
    },
  );

  server.registerResource(
    "catalog-manifest",
    "rfc://catalog/manifest",
    {
      title: "Catalog manifest",
      description: "RFC numbers present in the local catalog with title, status, stream and snapshot id.",
      mimeType: "application/json",
    },
    async (uri) => {
      const store = service.storeRef;
      const stats = store.status();
      const numbers = store.allCatalogNumbers();
      const records = store.getCatalogMany(numbers.slice(0, 5000));
      const manifest = {
        corpus_id: `rfc-mcp:${shortHash(store.path, 12)}`,
        index_generation: stats.index_generation,
        documents: records.map((record) => {
          const snapshot = store.getLatestSnapshot(record.rfc, "txt");
          return {
            document_id: record.document_id,
            rfc: record.rfc,
            title: record.title,
            status: record.status?.name ?? null,
            stream: record.stream?.name ?? null,
            published: record.published,
            snapshot_id: snapshot?.id ?? null,
            ingested: snapshot !== null,
          };
        }),
        truncated: numbers.length > records.length,
      };
      return {
        contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(manifest) }],
      };
    },
  );

  const snapshotTemplate = new ResourceTemplate(`rfc://snapshot/{snapshot_id}/{kind}/{item_id}`, {
    list: async () => ({ resources: [] }),
    complete: {
      snapshot_id: (value: string) => completeSnapshotIds(service, value),
      kind: (value: string) =>
        ["metadata", "provenance", "outline", "sections", "blocks", "requirements", "references", "citations"].filter(
          (kind) => kind.startsWith(value),
        ),
    },
  });

  server.registerResource(
    "snapshot-item",
    snapshotTemplate,
    {
      title: "Snapshot-scoped RFC data",
      description:
        "Bounded JSON view of a pinned snapshot: metadata, provenance, outline, one section, block, requirement, reference or citation.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { snapshot_id: snapshotId, kind, item_id: itemId } = readTemplateValues(uri);
      const store = service.storeRef;
      const snapshot = store.getSnapshot(snapshotId);
      if (!snapshot) throw notFound(uri, `Unknown snapshot ${snapshotId}`);

      const json = (value: unknown): { contents: { uri: string; mimeType: string; text: string }[] } => ({
        contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
      });

      switch (kind) {
        case "metadata": {
          const record = store.getCatalog(snapshot.rfc);
          return json({ document: record, snapshot });
        }
        case "provenance": {
          const raw = store.getSnapshotRaw(snapshot.id);
          return json({
            snapshot_id: snapshot.id,
            document_id: `rfc-${snapshot.rfc}`,
            source_uri: snapshot.source_url,
            raw_sha256: `sha256:${snapshot.raw_sha256}`,
            bytes: snapshot.bytes,
            retrieved_at: snapshot.retrieved_at,
            etag: snapshot.etag,
            last_modified: snapshot.last_modified,
            parser_version: snapshot.parser_version,
            extractor_version: snapshot.extractor_version,
            quality: snapshot.quality,
            warnings: snapshot.warnings,
            bytes_present: raw !== null,
            index_generation: store.getGeneration(),
          });
        }
        case "outline": {
          return json({ snapshot_id: snapshot.id, sections: store.getSections(snapshot.id) });
        }
        case "sections": {
          const section = store.getSectionById(snapshot.id, itemId);
          if (!section) throw notFound(uri, `Unknown section ${itemId}`);
          return json({ section, blocks: store.getBlocksForSection(snapshot.id, section.id) });
        }
        case "blocks": {
          const block = store.getBlock(snapshot.id, itemId);
          if (!block) throw notFound(uri, `Unknown block ${itemId}`);
          return json({ block });
        }
        case "requirements": {
          const requirement = store.getRequirementById(snapshot.id, itemId);
          if (!requirement) throw notFound(uri, `Unknown requirement ${itemId}`);
          return json({ requirement });
        }
        case "references": {
          const references = store.getReferences(snapshot.id, { limit: 1000, offset: 0 });
          const reference = references.find((candidate) => candidate.id === itemId);
          if (!reference) throw notFound(uri, `Unknown reference ${itemId}`);
          return json({ reference });
        }
        case "citations": {
          const envelope = await service.verifyCitation({ snapshot_id: snapshot.id, citation_id: itemId });
          return json(envelope.data);
        }
        default:
          throw notFound(uri, `Unsupported resource kind: ${kind}`);
      }
    },
  );

  // `rfc://snapshot/{id}/metadata|provenance|outline` have no trailing item id.
  const shortTemplate = new ResourceTemplate(`rfc://snapshot/{snapshot_id}/{kind}`, {
    list: async () => ({ resources: [] }),
    complete: {
      snapshot_id: (value: string) => completeSnapshotIds(service, value),
      kind: (value: string) => ["metadata", "provenance", "outline"].filter((kind) => kind.startsWith(value)),
    },
  });
  server.registerResource(
    "snapshot-view",
    shortTemplate,
    { title: "Snapshot metadata, provenance or outline", mimeType: "application/json" },
    async (uri) => {
      const { snapshot_id: snapshotId, kind } = readTemplateValues(uri);
      const store = service.storeRef;
      const snapshot = store.getSnapshot(snapshotId);
      if (!snapshot) throw notFound(uri, `Unknown snapshot ${snapshotId}`);
      if (kind === "metadata") {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(store.getCatalog(snapshot.rfc), null, 2),
            },
          ],
        };
      }
      if (kind === "provenance") {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ snapshot, index_generation: store.getGeneration() }, null, 2),
            },
          ],
        };
      }
      if (kind === "outline") {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(store.getSections(snapshot.id), null, 2),
            },
          ],
        };
      }
      throw notFound(uri, `Unsupported resource kind: ${kind}`);
    },
  );
}

function readTemplateValues(uri: URL): { snapshot_id: string; kind: string; item_id: string } {
  const path = uri.pathname.replace(/^\/+/u, "");
  const segments = path.split("/").map(decodeURIComponent);
  const snapshotId = segments[1] ?? "";
  const kind = segments[2] ?? "";
  const itemId = segments[3] ?? "";
  if (!new RegExp(`^${SNAPSHOT_PATTERN}$`, "u").test(snapshotId)) {
    throw new RfcMcpError("INVALID_ARGUMENT", "Snapshot id must match snp_<24 hex>", {
      details: { snapshot_id: snapshotId },
      retryable: false,
    });
  }
  if (!new RegExp(`^${ID_PATTERN}$`, "u").test(itemId) && itemId !== "") {
    throw new RfcMcpError("INVALID_ARGUMENT", "Resource item id contains unsupported characters", {
      details: { item_id: itemId.slice(0, 64) },
      retryable: false,
    });
  }
  return { snapshot_id: snapshotId, kind, item_id: itemId };
}

function completeSnapshotIds(_service: RfcService, _value: string): string[] {
  // Snapshot ids are opaque and unbounded; completion offers no candidates
  // rather than leaking a list of the whole corpus.
  return [];
}

export { isRfcMcpError };

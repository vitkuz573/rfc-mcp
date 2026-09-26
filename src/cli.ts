#!/usr/bin/env node
/**
 * Operator CLI (`rfc-mcp`).
 *
 * The model-visible MCP surface is strictly read-only. Corpus maintenance
 * (index sync, ingestion, index rebuild, maintenance) lives here so a model can
 * never mutate the corpus it is reasoning about.
 *
 *   rfc-mcp sync index                 # refresh the RFC catalog (metadata only)
 *   rfc-mcp sync rfc 2119 8174 9110    # ingest specific documents
 *   rfc-mcp sync all --limit 200       # ingest the first N catalog entries
 *   rfc-mcp sync rfc 9110 --refresh --with-xml
 *   rfc-mcp status                     # corpus health
 *   rfc-mcp outline 9110               # section tree of an RFC
 *   rfc-mcp requirements 9110 --scope 7
 *   rfc-mcp search "MUST NOT" --scope text
 *   rfc-mcp show 9110 --section 7.4.1  # print a section
 *   rfc-mcp verify <citation-id>
 *   rfc-mcp reindex                    # rebuild FTS from blocks
 *   rfc-mcp vacuum
 */

import { loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { isRfcMcpError } from "./core/errors.js";
import { buildServer } from "./mcp/server.js";
import type { RfcService } from "./service/rfcService.js";

const HELP = `rfc-mcp <command> [options]

Commands
  sync index                       Refresh the RFC catalog from the RFC Editor index.
  sync rfc <n> [<n> ...] [opts]    Ingest documents (parse + requirements + references).
  sync all [--limit N] [opts]      Ingest catalog entries in bulk.
  status                           Corpus health, generation and versions.
  outline <rfc>                    Section tree of an ingested document.
  requirements <rfc> [--scope S] [--term T] [--max N]
  references <rfc> [--relation R] [--max N]
  search <query> [--scope auto|catalog|text] [--max N]
  show <rfc> [--section S] [--max-bytes N]
  verify <citation-id>             Verify a citation against stored bytes.
  diff <left-rfc> <right-rfc> [--mode M]
  reanalyze <rfc> [<rfc> ...]      Re-derive analysis from stored bytes (offline).
  reanalyze --all                  Re-derive every ingested document (use after a version bump).
  reindex                          Rebuild FTS5 indexes from stored blocks.
  vacuum                           Compact the SQLite database.
  help                             This text.

Options
  --refresh        Re-fetch even when a snapshot exists.
  --with-xml       Also cache the RFCXML asset.
  --offline        Force offline mode for this invocation.
  --json           Machine-readable output.
  --concurrency N  Parallel ingests (default: RFC_MCP_MAX_CONCURRENCY).
  --limit N        Limit the number of documents.
  --max N          Limit returned rows.
  --cursor C       Continue a previous result set.
`;

interface Flags {
  refresh: boolean;
  withXml: boolean;
  offline: boolean;
  json: boolean;
  limit: number | null;
  max: number;
  cursor: string | null;
  concurrency: number | null;
  scope: string | null;
  term: string | null;
  relation: string | null;
  mode: string | null;
  section: string | null;
  maxBytes: number | null;
}

function parseFlags(argv: readonly string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {
    refresh: false,
    withXml: false,
    offline: false,
    json: false,
    limit: null,
    max: 50,
    cursor: null,
    concurrency: null,
    scope: null,
    term: null,
    relation: null,
    mode: null,
    section: null,
    maxBytes: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case "--refresh":
        flags.refresh = true;
        break;
      case "--with-xml":
        flags.withXml = true;
        break;
      case "--offline":
        flags.offline = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--limit":
        flags.limit = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--max":
        flags.max = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--max-bytes":
        flags.maxBytes = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--cursor":
        flags.cursor = next ?? null;
        i += 1;
        break;
      case "--concurrency":
        flags.concurrency = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--scope":
        flags.scope = next ?? null;
        i += 1;
        break;
      case "--term":
        flags.term = next ?? null;
        i += 1;
        break;
      case "--relation":
        flags.relation = next ?? null;
        i += 1;
        break;
      case "--mode":
        flags.mode = next ?? null;
        i += 1;
        break;
      case "--section":
        flags.section = next ?? null;
        i += 1;
        break;
      case "--all":
        // Not a global flag: only `reanalyze --all` means anything, and it is
        // dispatched as a positional so the command can reject it elsewhere.
        positionals.push(arg);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function emit(flags: Flags, payload: unknown, human: () => void): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  human();
}

async function withService<T>(flags: Flags, run: (service: RfcService) => Promise<T>): Promise<T> {
  if (flags.offline) process.env.RFC_MCP_OFFLINE = "1";
  const config = loadConfig();
  const logger = createLogger({ level: flags.json ? "error" : config.logLevel, base: { cli: "rfc-mcp" } });
  const built = buildServer({ config, logger });
  try {
    return await run(built.service);
  } finally {
    built.service.close();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const [command, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);

  switch (command) {
    case "sync": {
      const target = positionals[0] ?? "index";
      if (target === "index") {
        const result = await withService(flags, (service) => service.syncIndex());
        emit(flags, result, () => {
          process.stdout.write(
            `catalog synced: ${result.total} entries (${result.inserted} new, ${result.updated} updated)\n`,
          );
        });
        return 0;
      }
      if (target === "all") {
        const numbers = await withService(flags, async (service) => {
          const store = service.storeRef;
          const all = store.allCatalogNumbers();
          return flags.limit ? all.slice(0, flags.limit) : all;
        });
        const result = await withService(flags, (service) =>
          service.ingestMany(numbers, {
            refresh: flags.refresh,
            withXml: flags.withXml,
            ...(flags.concurrency ? { concurrency: flags.concurrency } : {}),
            onProgress: (done, total) => {
              if (!flags.json) process.stderr.write(`\r${done}/${total}`);
            },
          }),
        );
        if (!flags.json) process.stderr.write("\n");
        emit(flags, result, () => {
          process.stdout.write(`ingested ${result.ok}/${numbers.length}; failed ${result.failed.length}\n`);
          for (const failure of result.failed.slice(0, 20)) {
            process.stdout.write(`  rfc${failure.rfc}: ${failure.code} ${failure.message}\n`);
          }
        });
        return result.failed.length === 0 ? 0 : 1;
      }
      if (target === "rfc") {
        const numbers = positionals.slice(1).map((value) => Number.parseInt(value.replace(/^rfc/iu, ""), 10));
        if (numbers.some((value) => !Number.isInteger(value) || value <= 0)) {
          throw new Error("sync rfc expects RFC numbers, e.g. `rfc-mcp sync rfc 2119 8174`");
        }
        const result = await withService(flags, (service) =>
          service.ingestMany(numbers, {
            refresh: flags.refresh,
            withXml: flags.withXml,
            ...(flags.concurrency ? { concurrency: flags.concurrency } : {}),
            onProgress: (done, total) => {
              if (!flags.json) process.stderr.write(`\r${done}/${total}`);
            },
          }),
        );
        if (!flags.json) process.stderr.write("\n");
        emit(flags, result, () => {
          for (const item of result.failed) {
            process.stdout.write(`rfc${item.rfc}: ${item.code} ${item.message}\n`);
          }
          process.stdout.write(`ok ${result.ok}, failed ${result.failed.length}\n`);
        });
        return result.failed.length === 0 ? 0 : 1;
      }
      throw new Error(`Unknown sync target: ${target}`);
    }

    case "status": {
      const envelope = await withService(flags, (service) => service.status({ include_failures: true }));
      emit(flags, envelope, () => {
        const data = envelope.data;
        process.stdout.write(
          [
            `state:            ${data.state}`,
            `offline:          ${data.offline}`,
            `index generation: ${data.index_generation}`,
            `catalog:          ${data.documents.catalog}`,
            `snapshots:        ${data.documents.snapshots}`,
            `with requirements:${String(data.documents.with_requirements).padStart(3)}`,
            `last sync:        ${data.last_successful_sync ?? "never"}`,
            `warnings:         ${envelope.warnings.join(", ") || "none"}`,
          ].join("\n") + "\n",
        );
      });
      return 0;
    }

    case "outline": {
      const rfc = Number(positionals[0]);
      const envelope = await withService(flags, (service) =>
        service.read({ rfc, target: "outline", refresh: flags.refresh }),
      );
      emit(flags, envelope, () => {
        const sections = (envelope.data.outline ?? []) as readonly {
          number: string;
          title: string;
          kind: string;
          id: string;
        }[];
        for (const section of sections) {
          const indent = "  ".repeat(Math.max(0, section.number.match(/\./gu)?.length ?? 0));
          process.stdout.write(
            `${section.number.padEnd(10)} ${indent}${section.title}  [${section.kind}] ${section.id}\n`,
          );
        }
      });
      return 0;
    }

    case "requirements": {
      const rfc = Number(positionals[0]);
      const envelope = await withService(flags, (service) =>
        service.requirements({
          rfc,
          max_results: flags.max,
          ...(flags.scope ? { scope: flags.scope } : {}),
          ...(flags.term ? { term: flags.term } : {}),
          ...(flags.cursor ? { cursor: flags.cursor } : {}),
        }),
      );
      emit(flags, envelope, () => {
        const data = envelope.data as {
          requirements: {
            section: string | null;
            term: string;
            exact_text: string;
            citation_id: string;
            parse_status: string;
          }[];
        };
        for (const requirement of data.requirements) {
          process.stdout.write(
            `${(requirement.section ?? "?").padEnd(8)} ${requirement.term.padEnd(16)} ${requirement.parse_status.padEnd(9)} ${requirement.citation_id}\n`,
          );
          process.stdout.write(`         ${requirement.exact_text.replace(/\s+/gu, " ").slice(0, 200)}\n`);
        }
        process.stdout.write(
          `\ntotal: ${String((envelope.data as { coverage: { total_requirements: number } }).coverage.total_requirements)}\n`,
        );
      });
      return 0;
    }

    case "references": {
      const rfc = Number(positionals[0]);
      const envelope = await withService(flags, (service) =>
        service.references({
          rfc,
          max_results: flags.max,
          ...(flags.relation ? { relation: flags.relation as "normative" } : {}),
        }),
      );
      emit(flags, envelope, () => {
        const data = envelope.data as {
          references: {
            label: string;
            relation: string;
            target: string | null;
            resolution: string;
            cited_by: unknown[];
          }[];
          total: number;
        };
        for (const reference of data.references) {
          process.stdout.write(
            `${reference.label.padEnd(16)} ${reference.relation.padEnd(12)} ${(reference.target ?? "-").padEnd(14)} ${reference.resolution.padEnd(10)} cited ${reference.cited_by.length}\n`,
          );
        }
        process.stdout.write(`\ntotal: ${data.total}\n`);
      });
      return 0;
    }

    case "search": {
      const query = positionals.join(" ");
      const envelope = await withService(flags, (service) =>
        service.search({
          query,
          scope: (flags.scope as "auto" | "catalog" | "text" | null) ?? "auto",
          max_results: flags.max,
          ...(flags.cursor ? { cursor: flags.cursor } : {}),
        }),
      );
      emit(flags, envelope, () => {
        const data = envelope.data as {
          scope: string;
          hits: { rfc: number; title: string; snippet: string; citation_id: string | null }[];
          total: number;
        };
        process.stdout.write(`scope=${data.scope} total=${data.total}\n`);
        for (const hit of data.hits) {
          process.stdout.write(
            `RFC ${hit.rfc} ${hit.title}\n  ${hit.snippet.replace(/\s+/gu, " ").slice(0, 200)}\n  ${hit.citation_id ?? ""}\n`,
          );
        }
        if (envelope.next_cursor) process.stdout.write(`\nnext_cursor: ${envelope.next_cursor}\n`);
      });
      return 0;
    }

    case "show": {
      const rfc = Number(positionals[0]);
      const envelope = await withService(flags, (service) =>
        service.read({
          rfc,
          ...(flags.section ? { section: flags.section } : {}),
          format: "text",
          include: ["text"],
          ...(flags.maxBytes ? { max_output_bytes: flags.maxBytes } : {}),
        }),
      );
      emit(flags, envelope, () => {
        const data = envelope.data as {
          snapshot: { id: string };
          text: string | null;
          section: { number: string; title: string } | null;
        };
        process.stdout.write(`# ${data.section?.number ?? ""} ${data.section?.title ?? ""}  (${data.snapshot.id})\n\n`);
        process.stdout.write(`${data.text ?? ""}\n`);
      });
      return 0;
    }

    case "verify": {
      const citationId = positionals[0] ?? "";
      const envelope = await withService(flags, (service) => service.verifyCitation({ citation_id: citationId }));
      emit(flags, envelope, () => {
        const data = envelope.data as { verdict: string; notes: string[] };
        process.stdout.write(`${data.verdict}\n${data.notes.join("\n")}\n`);
      });
      return (envelope.data as { verdict: string }).verdict === "verified" ? 0 : 2;
    }

    case "diff": {
      const left = Number(positionals[0]);
      const right = Number(positionals[1]);
      const envelope = await withService(flags, (service) =>
        service.diff({
          left: { rfc: left },
          right: { rfc: right },
          mode: (flags.mode as "requirements" | undefined) ?? "requirements",
          max_changes: flags.max,
        }),
      );
      emit(flags, envelope, () => {
        const data = envelope.data as unknown as {
          changes: readonly { kind: string; before: unknown; after: unknown }[];
          summary: Record<string, number>;
        };
        process.stdout.write(`${JSON.stringify(data.summary)}\n`);
        for (const change of data.changes) {
          process.stdout.write(`${change.kind}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}\n`);
        }
      });
      return 0;
    }

    case "reanalyze": {
      // `reanalyze --all` is the counterpart of a parser or extractor version bump:
      // the whole corpus has to be re-derived from stored bytes, and enumerating
      // every ingested RFC by hand is the step most likely to be forgotten.
      const all = positionals.includes("--all") || positionals[0] === "all";
      const rest = positionals.filter((value) => value !== "--all" && value !== "all");
      const numbers = rest.map((value) => Number.parseInt(value.replace(/^rfc/iu, ""), 10));
      if (!all && (numbers.length === 0 || numbers.some((value) => !Number.isInteger(value)))) {
        throw new Error("reanalyze expects RFC numbers or --all, e.g. `rfc-mcp reanalyze 9110`");
      }
      if (all && numbers.length > 0) {
        throw new Error("reanalyze takes either --all or RFC numbers, not both");
      }
      const results = await withService(flags, async (service) => {
        const out: unknown[] = [];
        if (all) {
          const ingested = service.storeRef.listIngestedRfcs();
          for (const rfc of ingested) out.push(await service.reanalyze(rfc));
        } else {
          for (const rfc of numbers) out.push(await service.reanalyze(rfc));
        }
        return out;
      });
      emit(flags, results, () => {
        let changed = 0;
        for (const item of results as { rfc: number; from: string; to: string; changed: boolean }[]) {
          if (item.changed) changed += 1;
          if (!flags.json) {
            process.stdout.write(`rfc${item.rfc}: ${item.changed ? `${item.from} -> ${item.to}` : "unchanged"}\n`);
          }
        }
        if (flags.json) {
          process.stdout.write(
            `${JSON.stringify({ reanalyzed: results.length, changed, unchanged: results.length - changed })}\n`,
          );
        } else {
          process.stdout.write(`${changed} of ${results.length} documents re-derived\n`);
        }
      });
      return 0;
    }

    case "reindex": {
      const stats = await withService(flags, async (service) => {
        service.storeRef.rebuildSearchIndex();
        return service.storeRef.status();
      });
      emit(flags, stats, () => {
        process.stdout.write(`reindexed: ${stats.blocks} blocks, ${stats.catalog} catalog entries\n`);
      });
      return 0;
    }

    case "vacuum": {
      const purged = await withService(flags, async (service) => {
        const orphans = service.storeRef.purgeOrphanIndexRows();
        service.storeRef.vacuum();
        return orphans;
      });
      emit(flags, { purged_orphan_index_rows: purged }, () =>
        process.stdout.write(`purged ${purged} orphan search-index rows\nvacuum done\n`),
      );
      return 0;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (isRfcMcpError(error)) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      if (Object.keys(error.details).length > 0) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
    } else {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });

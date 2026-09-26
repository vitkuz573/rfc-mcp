/**
 * Black-box protocol test: spawns the built stdio server and speaks raw
 * JSON-RPC, so the wire behaviour (framing, both protocol eras, error codes,
 * stdout hygiene) is verified exactly as a host sees it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "dist", "index.js");

class RpcClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly notifications: unknown[] = [];
  readonly rawLines: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim() !== "") {
        this.rawLines.push(line);
        const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: unknown };
        if (typeof message.id === "number") {
          const entry = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (entry) {
            if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
            else entry.resolve(message.result);
          }
        } else {
          this.notifications.push(message);
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(payload);
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
}

describe("stdio protocol (legacy 2025 era)", () => {
  let child: ChildProcessWithoutNullStreams;
  let client: RpcClient;
  let dir: string;
  let stderr = "";

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-proto-"));
    child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, RFC_MCP_DATA_DIR: dir, RFC_MCP_OFFLINE: "1", RFC_MCP_LOG_LEVEL: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    client = new RpcClient(child);
  });

  afterAll(() => {
    child.stdin.end();
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  it("completes the classic initialize handshake", async () => {
    const result = await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "protocol-test", version: "1.0.0" },
    });
    expect(result.serverInfo.name).toBe("rfc");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
    expect(result.capabilities.prompts).toBeDefined();
    expect(result.instructions).toContain("rfc_resolve");
    client.notify("notifications/initialized", {});
  });

  it("advertises exactly the audited tool surface", async () => {
    const result = await client.request("tools/list", {});
    const names = (result.tools as { name: string }[]).map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "batch",
        "capabilities",
        "dependencies",
        "diff",
        "errata",
        "history",
        "metadata",
        "read",
        "references",
        "requirements",
        "resolve",
        "search",
        "source",
        "status",
        "verify_citation",
      ].sort(),
    );
    for (const tool of result.tools as { annotations?: Record<string, unknown>; outputSchema?: unknown }[]) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("returns structured results for a read-only call", async () => {
    const result = await client.request("tools/call", { name: "capabilities", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.contract).toBe("ietf-rfc/1");
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data.tools).toContain("verify_citation");
  });

  it("reports offline misses as a tool error, not a protocol error", async () => {
    const result = await client.request("tools/call", { name: "resolve", arguments: { rfc: 2119 } });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.code).toBe("NOT_CACHED");
    expect(payload.status).toBe("degraded");
  });

  it("rejects invalid tool arguments through the schema", async () => {
    const result = await client.request("tools/call", { name: "read", arguments: { snapshot_id: "not-a-snapshot" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("validates a batch operation against the schema of the tool it names", async () => {
    const bad = { op: "search", query: "MUST", section: "2" };
    const rejected = await client.request("tools/call", { name: "batch", arguments: { operations: [bad] } });
    // A rejected operation is reported per item, so the batch itself still answers.
    expect(rejected.isError).toBeFalsy();
    const onlyBad = JSON.parse(rejected.content[0].text);
    expect(onlyBad.status).toBe("degraded");
    expect(onlyBad.data.complete).toBe(false);
    expect(onlyBad.data.results[0].error.code).toBe("INVALID_ARGUMENT");
    expect(onlyBad.data.results[0].error.message).toContain("section");

    const mixed = await client.request("tools/call", {
      name: "batch",
      arguments: { operations: [bad, { op: "status" }] },
    });
    const payload = JSON.parse(mixed.content[0].text);
    expect(payload.status).toBe("partial");
    expect(payload.data.results.map((r: { status: string }) => r.status)).toEqual(["failed", "ok"]);
  });

  it("rejects an unknown tool argument instead of ignoring it", async () => {
    // A misspelled filter must never be dropped: the caller would receive
    // unfiltered data that looks filtered. The handler re-validates strictly so the
    // guarantee does not depend on the client or SDK validating first.
    const result = await client.request("tools/call", {
      name: "search",
      arguments: { query: "MUST", section: "2" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("section");
  });

  it("answers an unknown method with a protocol error", async () => {
    await expect(client.request("does/not/exist", {})).rejects.toThrowError(/-32601/u);
  });

  it("serves the declared resources", async () => {
    const list = await client.request("resources/list", {});
    const uris = (list.resources as { uri: string }[]).map((resource) => resource.uri);
    expect(uris).toContain("rfc://index/status");
    expect(uris).toContain("rfc://catalog/manifest");

    const templates = await client.request("resources/templates/list", {});
    const templateUris = (templates.resourceTemplates as { uriTemplate: string }[]).map((item) => item.uriTemplate);
    expect(templateUris.some((uri) => uri.includes("{snapshot_id}"))).toBe(true);

    const status = await client.request("resources/read", { uri: "rfc://index/status" });
    expect(JSON.parse(status.contents[0].text).state).toBeDefined();
  });

  it("serves prompts", async () => {
    const list = await client.request("prompts/list", {});
    const names = (list.prompts as { name: string }[]).map((prompt) => prompt.name).sort();
    expect(names).toEqual([
      "brief",
      "citation_check",
      "compare",
      "dependency_review",
      "offline_review",
      "requirements_audit",
    ]);
    const prompt = await client.request("prompts/get", { name: "brief", arguments: { document: "9110" } });
    const text = prompt.messages[0].content.text as string;
    expect(text).toContain("rfc_resolve");
    expect(text).toContain("untrusted");
  });

  it("keeps stdout free of anything but JSON-RPC frames", () => {
    expect(client.rawLines.length).toBeGreaterThan(0);
    for (const line of client.rawLines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      expect(message.jsonrpc).toBe("2.0");
    }
  });

  it("logs diagnostics to stderr only", () => {
    expect(stderr).not.toContain('"jsonrpc"');
  });
});

describe("stdio protocol (modern 2026-07-28 era)", () => {
  let child: ChildProcessWithoutNullStreams;
  let client: RpcClient;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-proto-modern-"));
    child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, RFC_MCP_DATA_DIR: dir, RFC_MCP_OFFLINE: "1", RFC_MCP_LOG_LEVEL: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    client = new RpcClient(child);
  });

  afterAll(() => {
    child.stdin.end();
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers server/discover", async () => {
    const result = await client.request("server/discover", {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "protocol-test", version: "1.0.0" },
      },
    });
    expect(result.supportedVersions).toContain("2026-07-28");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("lists tools with the modern request envelope", async () => {
    const result = await client.request("tools/list", {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "protocol-test", version: "1.0.0" },
      },
    });
    const names = (result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("resolve");
  });
});

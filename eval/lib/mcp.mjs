// Minimal stdio MCP client.
//
// The bench must exercise the same surface an agent does: the same wire contract,
// the same input schemas, the same warnings, the same snapshot pinning. Calling the
// service in-process would skip all of that - it is a different instrument, and an
// instrument that measures a code path nobody uses measures nothing. So this speaks
// JSON-RPC to `dist/index.js` over stdio and calls tools by name.
//
// No SDK dependency: the protocol this needs is initialize / initialized / tools/call
// with newline-delimited JSON, and hand-rolling it keeps the harness auditable.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class McpStdio {
  #child;
  #rl;
  #next = 1;
  #pending = new Map();
  #capabilities;

  constructor(serverPath, extraArgs = []) {
    this.#child = spawn(process.execPath, [serverPath, ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#rl = createInterface({ input: this.#child.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));
    this.stderr = [];
    this.#child.stderr.on("data", (b) => this.stderr.push(String(b)));
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // A server that logs to stdout is misbehaving; ignore rather than hang.
    }
    if (msg.id === undefined) return; // notification or request we do not serve
    const waiter = this.#pending.get(msg.id);
    if (!waiter) return;
    this.#pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else waiter.resolve(msg.result);
  }

  #send(payload) {
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #request(method, params) {
    const id = this.#next++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 120000).unref?.();
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async initialize() {
    this.#capabilities = await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "rfc-mcp-eval", version: "0.0.0" },
    });
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this.#capabilities;
  }

  async listTools() {
    const res = await this.#request("tools/list", {});
    return (res.tools ?? []).map((t) => t.name);
  }

  /** One tools/call. Returns the raw envelope: contract, status, data, provenance, warnings. */
  async call(name, args) {
    const res = await this.#request("tools/call", { name, arguments: args });
    // The server returns the envelope as a JSON text content block, plus structuredContent.
    if (res.structuredContent) return res.structuredContent;
    const block = (res.content ?? []).find((c) => c.type === "text");
    if (!block) throw new Error(`no content from ${name}`);
    // A rejected call answers with prose, not JSON. Surfacing it as a value rather
    // than a throw keeps "the tool refused this input" measurable instead of fatal.
    try {
      return JSON.parse(block.text);
    } catch {
      return { __error: block.text, __isError: res.isError === true };
    }
  }

  async close() {
    try {
      await this.#request("shutdown", null);
    } catch {
      /* the server may not implement shutdown; the kill below is enough */
    }
    this.#child.kill();
  }
}

/** Opens a session against the built server and returns { mcp, tools }. */
export async function connect(serverPath = "dist/index.js") {
  const mcp = new McpStdio(serverPath);
  await mcp.initialize();
  const tools = await mcp.listTools();
  return { mcp, tools };
}

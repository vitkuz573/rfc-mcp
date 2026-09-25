#!/usr/bin/env node
/**
 * stdio MCP server entry point (`rfc-mcp-server`).
 *
 * stdout is protocol-only from the first byte: nothing may be written to it
 * before `serveStdio` takes over.
 */

import { main } from "./mcp/server.js";

main();

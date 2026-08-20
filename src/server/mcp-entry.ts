#!/usr/bin/env node
// Real entry point for the sync-hub MCP server, meant to be registered with Claude Code / Codex
// as a stdio MCP server (e.g. `claude mcp add sync-hub -- node <path>/dist/server/mcp-entry.js`).
// Each tool session spawns its own short-lived instance of this process; it opens the same
// SQLite file the background daemon writes to (WAL mode supports this concurrent read).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Db } from '../core/db.js';
import { createMcpServer } from '../core/mcp-server.js';

const DATA_DIR = process.env.SYNC_HUB_DATA_DIR ?? join(homedir(), 'Projets', 'sync-hub', 'data');
const db = new Db(join(DATA_DIR, 'hub.sqlite'));

const server = createMcpServer(db);
await server.connect(new StdioServerTransport());

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

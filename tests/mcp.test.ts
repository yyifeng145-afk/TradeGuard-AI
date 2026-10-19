import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes 18 governed tools and enforces tenant scope", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "server/mcp.ts"],
    env: { ...process.env, CRM_DB_PATH: ":memory:", CRM_MCP_EMAIL: "sales@northstar.demo", CRM_MCP_PASSWORD: "Demo123!" }
  });
  const client = new Client({ name: "crm-mcp-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 18);
    assert.ok(!catalog.tools.some((tool) => /approve|send/.test(tool.name)));
    const own = await client.callTool({ name: "get_customer_profile", arguments: { customerId: "cust_acme" } });
    assert.equal(own.isError, undefined);
    assert.match(JSON.stringify(own.content), /Acme Imports/);
    const other = await client.callTool({ name: "get_customer_profile", arguments: { customerId: "cust_other" } });
    assert.equal(other.isError, true);
  } finally {
    await client.close();
  }
});

test("MCP sales access follows customer ownership and account revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crm-mcp-access-"));
  const dbPath = join(directory, "crm.sqlite");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "server/mcp.ts"],
    env: { ...process.env, CRM_DB_PATH: dbPath, CRM_MCP_EMAIL: "sales@northstar.demo", CRM_MCP_PASSWORD: "Demo123!" }
  });
  const client = new Client({ name: "crm-mcp-access-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE customers SET owner_id=? WHERE id=?").run("user_manager", "cust_meridian");
      const list = await client.callTool({ name: "list_customers", arguments: {} });
      assert.doesNotMatch(JSON.stringify(list.content), /Meridian Trading/);
      const forbidden = await client.callTool({ name: "get_customer_profile", arguments: { customerId: "cust_meridian" } });
      assert.equal(forbidden.isError, true);
      const own = await client.callTool({ name: "get_customer_profile", arguments: { customerId: "cust_acme" } });
      assert.equal(own.isError, undefined);

      db.prepare("UPDATE users SET is_active=0 WHERE id=?").run("user_sales");
      const revoked = await client.callTool({ name: "search_products", arguments: { query: "AX-200" } });
      assert.equal(revoked.isError, true);
    } finally {
      db.close();
    }
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

const execute = promisify(execFile);
const source = process.argv[2] ? resolve(process.argv[2]) : "";
const targetUrl = process.env.DATABASE_RESTORE_URL;
if (!source || !existsSync(source)) throw new Error("用法：pnpm restore:drill -- <backup.dump>");
if (!targetUrl) throw new Error("必须设置指向隔离数据库的 DATABASE_RESTORE_URL");
if (process.env.RESTORE_DRILL_CONFIRM !== "isolated-database") throw new Error("设置 RESTORE_DRILL_CONFIRM=isolated-database 后才能执行恢复演练");
const target = new URL(targetUrl);
const databaseName = decodeURIComponent(target.pathname.slice(1));
if (!/(restore|drill|test)/i.test(databaseName)) throw new Error("恢复演练数据库名称必须包含 restore、drill 或 test");

const startedAt = Date.now();
await execute(process.env.PG_RESTORE_PATH || "pg_restore", [
  "--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error",
  `--host=${target.hostname}`, `--port=${target.port || "5432"}`,
  `--username=${decodeURIComponent(target.username)}`, `--dbname=${databaseName}`, source,
], {
  env: { ...process.env, PGPASSWORD: decodeURIComponent(target.password) },
  windowsHide: true,
  timeout: Number(process.env.RESTORE_TIMEOUT_MS ?? 900_000),
});

const client = new Client({ connectionString: targetUrl, application_name: "tradeguard-restore-drill" });
await client.connect();
try {
  const required = ["organizations", "users", "customers", "messages", "quotes", "sales_orders", "audit_events"];
  const result = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = required.filter((table) => !present.has(table));
  if (missing.length) throw new Error(`恢复副本缺少必要数据表：${missing.join(", ")}`);
  const counts: Record<string, number> = {};
  for (const table of required) {
    const row = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "${table}"`);
    counts[table] = Number(row.rows[0].count);
  }
  console.log(JSON.stringify({ ok: true, source, targetDatabase: databaseName, rtoSeconds: Math.ceil((Date.now() - startedAt) / 1000), counts }, null, 2));
} finally {
  await client.end();
}

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";

const sourcePath = resolve(process.env.SQLITE_SOURCE_PATH ?? "");
const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!process.env.SQLITE_SOURCE_PATH || !existsSync(sourcePath)) throw new Error("SQLITE_SOURCE_PATH 必须指向迁移源 SQLite 文件");
if (!databaseUrl) throw new Error("必须配置 DATABASE_MIGRATION_URL 或 DATABASE_URL");
if (process.env.MIGRATION_CONFIRM !== "sqlite-to-postgres") throw new Error("设置 MIGRATION_CONFIRM=sqlite-to-postgres 后才能执行迁移");

const safeIdentifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`不安全的数据库标识符：${value}`);
  return `"${value}"`;
};
const source = new DatabaseSync(sourcePath, { readOnly: true });
const target = new Client({ connectionString: databaseUrl, application_name: "tradeguard-sqlite-migration" });
const retiredRuntimeTables = new Set(["sessions", "login_attempts", "agent_jobs", "worker_heartbeats"]);

type SchemaRow = { type: "table" | "index"; name: string; tbl_name: string; sql: string | null };
const normalizeDdl = (sql: string) => sql
  .replace(/\bCREATE TABLE\b/i, "CREATE TABLE IF NOT EXISTS")
  .replace(/\bCREATE UNIQUE INDEX\b/i, "CREATE UNIQUE INDEX IF NOT EXISTS")
  .replace(/\bCREATE INDEX\b/i, "CREATE INDEX IF NOT EXISTS")
  .replace(/\bAUTOINCREMENT\b/gi, "");

try {
  await target.connect();
  await target.query("SELECT pg_advisory_lock(hashtext('tradeguard-sqlite-migration'))");
  await target.query("BEGIN");
  const schema = source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,rowid").all() as unknown as SchemaRow[];
  const tables = schema.filter((item) => item.type === "table" && !retiredRuntimeTables.has(item.name));
  for (const item of tables) await target.query(normalizeDdl(item.sql!));

  const verification: Array<{ table: string; sourceRows: number; targetRows: number; sourceHash: string; targetHash: string }> = [];
  for (const item of tables) {
    const table = safeIdentifier(item.name);
    const columnInfo = source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    const columns = columnInfo.map((column) => column.name);
    const primary = columnInfo.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    const ordering = (primary.length ? primary : columns).map(safeIdentifier).join(",");
    const rows = source.prepare(`SELECT * FROM ${table} ORDER BY ${ordering}`).all() as Array<Record<string, string | number | null>>;
    for (const row of rows) {
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(",");
      await target.query(`INSERT INTO ${table} (${columns.map(safeIdentifier).join(",")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, columns.map((column) => row[column]));
    }
    const targetRows = Number((await target.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`)).rows[0].count);
    if (targetRows !== rows.length) throw new Error(`${item.name} 行数不一致：SQLite=${rows.length}, PostgreSQL=${targetRows}`);
    const sourceHash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const targetData = (await target.query(`SELECT * FROM ${table} ORDER BY ${ordering}`)).rows;
    const targetHash = createHash("sha256").update(JSON.stringify(targetData)).digest("hex");
    if (targetHash !== sourceHash) throw new Error(`${item.name} 内容哈希不一致：SQLite=${sourceHash}, PostgreSQL=${targetHash}`);
    verification.push({ table: item.name, sourceRows: rows.length, targetRows, sourceHash, targetHash });
  }
  for (const item of schema.filter((entry) => entry.type === "index" && !retiredRuntimeTables.has(entry.tbl_name))) await target.query(normalizeDdl(item.sql!));
  await target.query("DROP TABLE IF EXISTS sessions, login_attempts, agent_jobs, worker_heartbeats");
  await target.query(`CREATE TABLE IF NOT EXISTS queue_outbox (
    id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, job_name TEXT NOT NULL, job_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at TEXT NOT NULL, published_at TEXT)`);
  await target.query("CREATE INDEX IF NOT EXISTS idx_queue_outbox_pending ON queue_outbox(status,created_at)");
  await target.query("COMMIT");
  console.log(JSON.stringify({ ok: true, sourcePath, tables: verification }, null, 2));
} catch (error) {
  await target.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  source.close();
  await target.query("SELECT pg_advisory_unlock(hashtext('tradeguard-sqlite-migration'))").catch(() => undefined);
  await target.end();
}


import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const source = process.argv[2] ? resolve(process.argv[2]) : "";
if (!source || !existsSync(source)) throw new Error("用法：pnpm restore:drill -- <backup.sqlite>");
const directory = mkdtempSync(join(tmpdir(), "crm-restore-drill-"));
const restored = join(directory, basename(source));
try {
  copyFileSync(source, restored);
  const db = new DatabaseSync(restored);
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error(`integrity_check 失败：${integrity.integrity_check}`);
    const required = ["organizations", "users", "customers", "messages", "quotes", "sales_orders", "audit_events"];
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((item) => item.name));
    const missing = required.filter((name) => !tables.has(name));
    if (missing.length) throw new Error(`恢复副本缺少必要数据表：${missing.join(", ")}`);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error(`恢复副本存在 ${foreignKeys.length} 个外键错误`);
    const counts = Object.fromEntries(required.map((table) => [table, (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
    console.log(JSON.stringify({ ok: true, source, restoredCopy: restored, integrity: "ok", counts }, null, 2));
  } finally { db.close(); }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

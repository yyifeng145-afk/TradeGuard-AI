import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db, dbPath, id, initDatabase } from "./db.js";

const configuredDirectory = process.env.CRM_BACKUP_DIR;
if (!configuredDirectory || dbPath === ":memory:") {
  throw new Error("备份需要显式设置 CRM_BACKUP_DIR，且 CRM_DB_PATH 必须为持久化数据库");
}
initDatabase();
const directory = resolve(configuredDirectory);
mkdirSync(directory, { recursive: true });
const filename = `crm-${new Date().toISOString().replace(/[:.]/g, "-")}-${id().slice(0, 8)}.sqlite`;
const destination = join(directory, filename);
db.prepare("VACUUM INTO ?").run(destination);
const snapshot = new DatabaseSync(destination);
try {
  const result = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (result.integrity_check !== "ok") throw new Error(`备份完整性校验失败：${result.integrity_check}`);
} finally {
  snapshot.close();
}
if (statSync(destination).size === 0) throw new Error("备份文件为空");
console.log(`备份已完成并通过完整性校验：${destination}`);

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { id } from "./db.js";

const execute = promisify(execFile);
const configuredDirectory = process.env.CRM_BACKUP_DIR;
const connectionString = process.env.DATABASE_URL;
if (!configuredDirectory || !connectionString) {
  throw new Error("备份需要显式设置 CRM_BACKUP_DIR 和 DATABASE_URL");
}

const database = new URL(connectionString);
const directory = resolve(configuredDirectory);
await mkdir(directory, { recursive: true });
const filename = `crm-${new Date().toISOString().replace(/[:.]/g, "-")}-${id().slice(0, 8)}.dump`;
const destination = join(directory, filename);
const args = [
  "--format=custom",
  "--no-owner",
  "--no-privileges",
  `--host=${database.hostname}`,
  `--port=${database.port || "5432"}`,
  `--username=${decodeURIComponent(database.username)}`,
  `--file=${destination}`,
  decodeURIComponent(database.pathname.slice(1)),
];
await execute(process.env.PG_DUMP_PATH || "pg_dump", args, {
  env: { ...process.env, PGPASSWORD: decodeURIComponent(database.password) },
  windowsHide: true,
  timeout: Number(process.env.BACKUP_TIMEOUT_MS ?? 600_000),
});
const size = (await stat(destination)).size;
if (size === 0) throw new Error("PostgreSQL 备份文件为空");
await execute(process.env.PG_RESTORE_PATH || "pg_restore", ["--list", destination], {
  windowsHide: true,
  timeout: 60_000,
});
console.log(JSON.stringify({ ok: true, destination, sizeBytes: size }));

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { pgOne, pgQuery, pgTransaction, closePostgres } from "./platform/postgres.js";
import { assertRuntimeConfiguration } from "./config.js";

export type SqlValue = string | number | boolean | null;
export const now = () => new Date().toISOString();
export const id = () => randomUUID();

assertRuntimeConfiguration();

function postgresSql(sql: string) {
  let index = 0;
  let quoted = false;
  let converted = "";
  const ignoredInsert = /INSERT\s+OR\s+IGNORE/i.test(sql);
  const normalized = sql
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO")
    .replace(/\bIS\s+\?/gi, "IS NOT DISTINCT FROM ?");
  for (let position = 0; position < normalized.length; position++) {
    const character = normalized[position];
    if (character === "'" && normalized[position - 1] !== "\\") quoted = !quoted;
    if (character === "?" && !quoted) converted += `$${++index}`;
    else converted += character;
  }
  if (ignoredInsert && !/\bON\s+CONFLICT\b/i.test(converted)) {
    converted = `${converted.trim().replace(/;$/, "")} ON CONFLICT DO NOTHING`;
  }
  return converted;
}

export async function one<T>(sql: string, ...args: SqlValue[]): Promise<T | undefined> {
  return pgOne<T & Record<string, unknown>>(postgresSql(sql), args) as Promise<T | undefined>;
}

export async function all<T = Record<string, unknown>>(sql: string, ...args: SqlValue[]): Promise<T[]> {
  return (await pgQuery<T & Record<string, unknown>>(postgresSql(sql), args)).rows as T[];
}

export async function run(sql: string, ...args: SqlValue[]) {
  const result = await pgQuery(postgresSql(sql), args);
  return { changes: result.rowCount ?? 0 };
}

export function transaction<T>(operation: () => Promise<T>, isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED") {
  return pgTransaction(operation, isolation);
}

export function passwordHash(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password: string, salt: string, hash: string) {
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function passwordMaterial(password: string) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: passwordHash(password, salt) };
}

export async function initDatabase() {
  const schema = await one<{ organizations: string | null }>("SELECT to_regclass('public.organizations')::text AS organizations");
  if (!schema?.organizations) throw new Error("PostgreSQL schema is missing. Run pnpm migrate:sqlite-to-postgres before starting the API");
}

export async function audit(organizationId: string, actorId: string, action: string, targetType: string, targetId: string, detail: string) {
  await run("INSERT INTO audit_events(id,organization_id,actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?)",
    id(), organizationId, actorId, action, targetType, targetId, detail, now());
}

export const closeDatabase = closePostgres;

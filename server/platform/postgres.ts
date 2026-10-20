import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
let pool: Pool | undefined;
const transactionClient = new AsyncLocalStorage<PoolClient>();
function databaseUrl() {
    const value = process.env.DATABASE_URL;
    if (!value)
        throw new Error("DATABASE_URL is required for the PostgreSQL backend");
    return value;
}
export function postgresPool() {
    if (pool)
        return pool;
    pool = new Pool({
        connectionString: databaseUrl(),
        max: Math.min(50, Math.max(2, Number(process.env.PG_POOL_MAX ?? 10))),
        idleTimeoutMillis: Math.max(1000, Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000)),
        connectionTimeoutMillis: Math.max(1000, Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5000)),
        application_name: process.env.SERVICE_NAME ?? "tradeguard-crm"
    });
    pool.on("connect", (client) => {
        void client.query(`SET statement_timeout = ${Math.max(1000, Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15000))}`);
        void client.query("SET timezone = 'UTC'");
    });
    pool.on("error", (error) => console.error("PostgreSQL pool error", error));
    return pool;
}
export async function pgQuery<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    const client = transactionClient.getStore();
    return (client ?? postgresPool()).query<T>(text, values);
}
export async function pgOne<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return (await pgQuery<T>(text, values)).rows[0];
}
export async function pgTransaction<T>(operation: () => Promise<T>, isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED") {
    if (transactionClient.getStore())
        return operation();
    const client = await postgresPool().connect();
    try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const result = await transactionClient.run(client, operation);
        await client.query("COMMIT");
        return result;
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
export async function postgresHealth() {
    const started = performance.now();
    const result = await pgOne<{
        now: string;
    }>("SELECT now()::text AS now");
    return { ok: Boolean(result?.now), latencyMs: Math.round(performance.now() - started) };
}
export async function closePostgres() {
    const current = pool;
    pool = undefined;
    await current?.end();
}

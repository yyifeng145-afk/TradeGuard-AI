import { createClient, type RedisClientType } from "redis";
let client: RedisClientType | undefined;
function redisUrl() {
    const value = process.env.REDIS_URL;
    if (!value)
        throw new Error("REDIS_URL is required for Redis sessions, rate limits and queues");
    return value;
}
export async function redisClient() {
    if (!client) {
        client = createClient({ url: redisUrl(), socket: {
                connectTimeout: Math.max(1000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5000)),
                reconnectStrategy: (retries) => Math.min(2000, 50 * 2 ** Math.min(retries, 6))
            } });
        client.on("error", (error) => console.error("Redis client error", error));
    }
    if (!client.isOpen)
        await client.connect();
    return client;
}
export async function redisHealth() {
    const started = performance.now();
    const pong = await (await redisClient()).ping();
    return { ok: pong === "PONG", latencyMs: Math.round(performance.now() - started) };
}
export async function closeRedis() {
    const current = client;
    client = undefined;
    if (current?.isOpen)
        await current.quit();
}
export function redisConnectionOptions() {
    const url = new URL(redisUrl());
    const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
    return {
        host: url.hostname,
        port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        db: Number.isInteger(database) ? database : 0,
        tls: url.protocol === "rediss:" ? {} : undefined,
        maxRetriesPerRequest: null
    };
}

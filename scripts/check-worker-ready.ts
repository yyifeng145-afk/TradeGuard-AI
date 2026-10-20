import { one } from "../server/db.js";
import { closeQueues, queueHealth } from "../server/platform/queues.js";
import { closePostgres, postgresHealth } from "../server/platform/postgres.js";
import { closeRedis, redisClient, redisHealth } from "../server/platform/redis.js";

try {
  const [postgres, redis, queue] = await Promise.all([postgresHealth(), redisHealth(), queueHealth()]);
  const heartbeat = await (await redisClient()).get("crm:worker:agent:heartbeat");
  const heartbeatAgeMs = heartbeat ? Date.now() - Date.parse(heartbeat) : Number.POSITIVE_INFINITY;
  const pendingOutbox = Number((await one<{ count: number }>("SELECT COUNT(*)::int AS count FROM queue_outbox WHERE status='pending'"))?.count ?? 0);
  const ok = postgres.ok && redis.ok && queue.ok && heartbeatAgeMs < 60_000;
  console.log(JSON.stringify({ ok, postgres, redis, queue, heartbeatAgeMs, pendingOutbox }));
  if (!ok) process.exitCode = 1;
} finally {
  await Promise.allSettled([closeQueues(), closeRedis(), closePostgres()]);
}

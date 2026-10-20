import { postgresHealth, closePostgres } from "../server/platform/postgres.js";
import { redisHealth, closeRedis } from "../server/platform/redis.js";
import { queueHealth, closeQueues } from "../server/platform/queues.js";

try {
  const [postgres, redis, queue] = await Promise.all([postgresHealth(), redisHealth(), queueHealth()]);
  console.log(JSON.stringify({ ok: postgres.ok && redis.ok && queue.ok, postgres, redis, queue }, null, 2));
  if (!postgres.ok || !redis.ok || !queue.ok) process.exitCode = 1;
} finally {
  await Promise.allSettled([closeQueues(), closeRedis(), closePostgres()]);
}


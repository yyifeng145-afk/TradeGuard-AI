import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const required = process.env.REQUIRE_INTEGRATION === "true";
const available = Boolean(databaseUrl && redisUrl);
if (required && !available) throw new Error("REQUIRE_INTEGRATION=true 时必须设置 TEST_DATABASE_URL 和 TEST_REDIS_URL");
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
if (redisUrl) process.env.REDIS_URL = redisUrl;
process.env.APP_ENV = "test";

let pg: typeof import("../server/platform/postgres.js");
let redisPlatform: typeof import("../server/platform/redis.js");
let sessionStore: typeof import("../server/platform/session-store.js");

before(async () => {
  if (!available) return;
  pg = await import("../server/platform/postgres.js");
  redisPlatform = await import("../server/platform/redis.js");
  sessionStore = await import("../server/platform/session-store.js");
  const schema = await readFile(new URL("../deploy/postgres/init/001-schema.sql", import.meta.url), "utf8");
  await pg.pgQuery(schema);
});

after(async () => {
  if (!available) return;
  await pg.closePostgres();
  await redisPlatform.closeRedis();
});

test("PostgreSQL transaction commits and rolls back", { skip: !available }, async () => {
  const id = `it-${randomUUID()}`;
  await pg.pgTransaction(async () => { await pg.pgQuery("INSERT INTO organizations(id,name) VALUES($1,$2)", [id, "integration"]); });
  assert.equal((await pg.pgOne<{ name: string }>("SELECT name FROM organizations WHERE id=$1", [id]))?.name, "integration");
  await assert.rejects(pg.pgTransaction(async () => {
    await pg.pgQuery("UPDATE organizations SET name='bad' WHERE id=$1", [id]);
    throw new Error("rollback");
  }));
  assert.equal((await pg.pgOne<{ name: string }>("SELECT name FROM organizations WHERE id=$1", [id]))?.name, "integration");
  await pg.pgQuery("DELETE FROM organizations WHERE id=$1", [id]);
});

test("Redis sessions support lookup and user-wide revocation", { skip: !available }, async () => {
  const userId = `user-${randomUUID()}`;
  const first = await sessionStore.createRedisSession({ userId, organizationId: "org", csrfToken: "a" }, 60);
  const second = await sessionStore.createRedisSession({ userId, organizationId: "org", csrfToken: "b" }, 60);
  assert.equal((await sessionStore.getRedisSession(first))?.csrfToken, "a");
  await sessionStore.revokeUserSessions(userId, first);
  assert.ok(await sessionStore.getRedisSession(first));
  assert.equal(await sessionStore.getRedisSession(second), undefined);
  await sessionStore.deleteRedisSession(first);
});

test("Redis login limiter uses atomic expiring counters", { skip: !available }, async () => {
  const auth = await import("../server/auth.js");
  const identity = `${randomUUID()}@example.test`;
  const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  for (let attempt = 0; attempt < 5; attempt++) await auth.recordFailedLogin(identity, ip);
  await assert.rejects(auth.assertLoginAllowed(identity, ip), /登录尝试过多/);
  await auth.clearSuccessfulLogin(identity);
  await auth.assertLoginAllowed(identity, `203.0.113.${Math.floor(Math.random() * 200) + 1}`);
});

test("PostgreSQL transaction rolls queue outbox back with business failure", { skip: !available }, async () => {
  const { scheduleAgentJob } = await import("../server/queue-outbox.js");
  const runId = randomUUID();
  await assert.rejects(pg.pgTransaction(async () => {
    await scheduleAgentJob({ organizationId: "org", runId, kind: "analyze" });
    throw new Error("business write failed");
  }));
  const row = await pg.pgOne("SELECT id FROM queue_outbox WHERE job_key=$1", [`agent-${runId}-analyze-0`]);
  assert.equal(row, undefined);
});

test("BullMQ distributes jobs across multiple workers without duplicate effects", { skip: !available, timeout: 30_000 }, async () => {
  const { Queue, QueueEvents, Worker } = await import("bullmq");
  const name = `crm-it-${randomUUID()}`;
  const connection = redisPlatform.redisConnectionOptions();
  const queue = new Queue<{ key: string }>(name, { connection });
  const events = new QueueEvents(name, { connection });
  await events.waitUntilReady();
  const redis = await redisPlatform.redisClient();
  const processedKey = `${name}:processed`;
  const handler = async (job: { data: { key: string } }) => { await redis.sAdd(processedKey, job.data.key); };
  const workers = [new Worker(name, handler, { connection, concurrency: 3 }), new Worker(name, handler, { connection, concurrency: 3 })];
  try {
    const jobs = await Promise.all(Array.from({ length: 24 }, (_, index) => queue.add("work", { key: String(index) }, { jobId: `job-${index}` })));
    await Promise.all(jobs.map((job) => job.waitUntilFinished(events, 20_000)));
    await queue.add("work", { key: "0" }, { jobId: "job-0" });
    assert.equal(await redis.sCard(processedKey), 24);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.del(processedKey);
  }
});

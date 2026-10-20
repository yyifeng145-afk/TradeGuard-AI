import { Worker, type Job } from "bullmq";
import { audit, initDatabase, one, run } from "./db.js";
import { markAgentJobFailed, processAgentJob } from "./engine.js";
import { sendInternalNotificationOnce } from "./feishu.js";
import { syncConfirmedMemory } from "./mem0.js";
import { closeQueues, queueNames, type AgentQueuePayload, type IntegrationQueuePayload, type NotificationQueuePayload } from "./platform/queues.js";
import { closePostgres } from "./platform/postgres.js";
import { closeRedis, redisClient, redisConnectionOptions } from "./platform/redis.js";
import { markOutboxConsumed, publishOutboxBatch } from "./queue-outbox.js";

await initDatabase();
await run("UPDATE internal_notifications SET status='uncertain',last_error='Worker 在发送过程中中断；需要人工核对' WHERE status='sending'");
const connection = redisConnectionOptions();
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 4));

const agentWorker = new Worker<AgentQueuePayload>(queueNames.agent, async (job) => {
  await processAgentJob(job.data);
  await markOutboxConsumed(String(job.id));
}, { connection, concurrency });

const notificationWorker = new Worker<NotificationQueuePayload>(queueNames.notification, async (job) => {
  await sendInternalNotificationOnce(job.data.notificationId);
  await markOutboxConsumed(String(job.id));
}, { connection, concurrency: Math.min(4, concurrency) });

const integrationWorker = new Worker<IntegrationQueuePayload>(queueNames.integration, async (job) => {
  if (job.data.kind !== "mem0-sync") throw new Error(`不支持的外部同步任务：${job.data.kind}`);
  const memory = await one<{ customer_id: string; content: string }>(
    "SELECT customer_id,content FROM memories WHERE id=? AND organization_id=? AND status='confirmed'",
    job.data.targetId,
    job.data.organizationId,
  );
  if (!memory) {
    await markOutboxConsumed(String(job.id));
    return;
  }
  const result = await syncConfirmedMemory(job.data.organizationId, memory.customer_id, memory.content);
  if (result === "failed") throw new Error("Mem0 同步失败");
  await audit(job.data.organizationId, "integration_worker", `memory.mem0_${result}`, "memory", job.data.targetId, `Mem0 ${result}`);
  await markOutboxConsumed(String(job.id));
}, { connection, concurrency: Math.min(4, concurrency) });

agentWorker.on("failed", (job: Job<AgentQueuePayload> | undefined, error) => {
  if (!job) return;
  const attempts = Number(job.opts.attempts ?? 1);
  if (job.attemptsMade >= attempts) {
    void markAgentJobFailed(job.data, error).catch((failure) => console.error("Failed to persist terminal agent failure", failure));
  }
});
for (const worker of [agentWorker, notificationWorker, integrationWorker]) {
  worker.on("error", (error) => console.error(`${worker.name} worker error`, error));
}

const redis = await redisClient();
const heartbeat = async () => redis.set("crm:worker:agent:heartbeat", new Date().toISOString(), { EX: 60 });
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat().catch((error) => console.error("Worker heartbeat failed", error)), 10_000);
let publishing = false;
const publish = async () => {
  if (publishing) return;
  publishing = true;
  try { while (await publishOutboxBatch()) { /* drain transactional outbox */ } }
  finally { publishing = false; }
};
await publish();
const publisherTimer = setInterval(() => void publish().catch((error) => console.error("Queue outbox publisher failed", error)), 1_000);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  clearInterval(heartbeatTimer);
  clearInterval(publisherTimer);
  console.log(`CRM Worker stopping after ${signal}`);
  await Promise.all([agentWorker.close(), notificationWorker.close(), integrationWorker.close()]);
  await closeQueues();
  await closePostgres();
  await closeRedis();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
console.log(`CRM BullMQ Worker started (concurrency=${concurrency})`);

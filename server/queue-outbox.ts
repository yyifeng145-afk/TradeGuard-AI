import { all, id, now, run, transaction } from "./db.js";
import { reliableQueues, type AgentQueuePayload, type IntegrationQueuePayload, type NotificationQueuePayload } from "./platform/queues.js";

type OutboxRow = {
  id: string;
  queue_name: "agent" | "notification" | "integration";
  job_name: string;
  job_key: string;
  payload_json: string;
  attempt: number;
};

async function schedule(queueName: OutboxRow["queue_name"], jobName: string, jobKey: string, payload: unknown) {
  await run(
    "INSERT OR IGNORE INTO queue_outbox(id,queue_name,job_name,job_key,payload_json,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
    id(), queueName, jobName, jobKey, JSON.stringify(payload), now(),
  );
}

export async function scheduleAgentJob(payload: AgentQueuePayload) {
  await schedule("agent", payload.kind, `agent-${payload.runId}-${payload.kind}-${payload.generation ?? 0}`, payload);
}
export async function scheduleNotificationJob(payload: NotificationQueuePayload) {
  await schedule("notification", "send", `notification-${payload.notificationId}`, payload);
}
export async function scheduleIntegrationJob(payload: IntegrationQueuePayload) {
  await schedule("integration", payload.kind, `integration-${payload.kind}-${payload.targetId}`, payload);
}

export async function publishOutboxBatch(limit = 100) {
  return transaction(async () => {
    const staleBefore = new Date(Date.now() - 120_000).toISOString();
    await run("UPDATE queue_outbox SET status='pending' WHERE status='published' AND published_at<?", staleBefore);
    const rows = await all<OutboxRow>(`SELECT * FROM queue_outbox
      WHERE status='pending' ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED`, limit);
    const queues = reliableQueues();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      try {
        await queues[row.queue_name].add(row.job_name, payload, { jobId: row.job_key });
        await run("UPDATE queue_outbox SET status='published',published_at=?,last_error=NULL WHERE id=?", now(), row.id);
      } catch (error) {
        await run("UPDATE queue_outbox SET attempt=attempt+1,last_error=? WHERE id=?", String(error).slice(0, 500), row.id);
        throw error;
      }
    }
    return rows.length;
  });
}

export async function markOutboxConsumed(jobKey: string) {
  await run("UPDATE queue_outbox SET status='consumed' WHERE job_key=? AND status IN ('pending','published')", jobKey);
}

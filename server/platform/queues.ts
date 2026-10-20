import { Queue, type JobsOptions } from "bullmq";
import { redisConnectionOptions } from "./redis.js";
export const queueNames = {
    agent: "crm-agent",
    notification: "crm-notification",
    integration: "crm-integration"
} as const;
export type AgentQueuePayload = {
    organizationId: string;
    runId: string;
    kind: "analyze" | "dispatch";
    generation?: number;
};
export type NotificationQueuePayload = {
    organizationId: string;
    notificationId: string;
};
export type IntegrationQueuePayload = {
    organizationId: string;
    targetId: string;
    kind: "mem0-sync" | "weknora-sync";
};
const connection = () => redisConnectionOptions();
const defaults: JobsOptions = {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 86400, count: 10000 },
    removeOnFail: { age: 30 * 86400, count: 50000 }
};
let agentQueue: Queue<AgentQueuePayload> | undefined;
let notificationQueue: Queue<NotificationQueuePayload> | undefined;
let integrationQueue: Queue<IntegrationQueuePayload> | undefined;
export function reliableQueues() {
    agentQueue ??= new Queue<AgentQueuePayload>(queueNames.agent, { connection: connection(), defaultJobOptions: defaults });
    notificationQueue ??= new Queue<NotificationQueuePayload>(queueNames.notification, { connection: connection(), defaultJobOptions: defaults });
    integrationQueue ??= new Queue<IntegrationQueuePayload>(queueNames.integration, { connection: connection(), defaultJobOptions: defaults });
    return { agent: agentQueue, notification: notificationQueue, integration: integrationQueue };
}
export async function queueHealth() {
    const counts = await reliableQueues().agent.getJobCounts("waiting", "active", "delayed", "failed");
    return { ok: true, counts };
}
export async function closeQueues() {
    const queues = [agentQueue, notificationQueue, integrationQueue].filter((item): item is Queue => Boolean(item));
    agentQueue = notificationQueue = integrationQueue = undefined;
    await Promise.all(queues.map((queue) => queue.close()));
}

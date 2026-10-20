import { now, one } from "./db.js";
import { reliableQueues } from "./platform/queues.js";
import { redisClient } from "./platform/redis.js";

const metric = (name: string, help: string, value: number) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Number.isFinite(value) ? value : 0}`;
const counter = (name: string, help: string, value: number) => `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${Number.isFinite(value) ? value : 0}`;
let http5xxTotal = 0;

export function recordHttpResponse(statusCode: number) {
  if (statusCode >= 500) http5xxTotal += 1;
}

export async function productionMetrics() {
  const queues = reliableQueues();
  const redis = await redisClient();
  const [agent, notification, integration, database, heartbeat, notificationProblems, riskOrders, outboxPending] = await Promise.all([
    queues.agent.getJobCounts("waiting", "active", "delayed", "failed"),
    queues.notification.getJobCounts("waiting", "active", "delayed", "failed"),
    queues.integration.getJobCounts("waiting", "active", "delayed", "failed"),
    one<{ size: number }>("SELECT pg_database_size(current_database())::bigint AS size"),
    redis.get("crm:worker:agent:heartbeat"),
    one<{ count: number }>("SELECT COUNT(*)::int AS count FROM internal_notifications WHERE status IN ('failed','uncertain')"),
    one<{ count: number }>("SELECT COUNT(*)::int AS count FROM sales_orders WHERE status='at_risk'"),
    one<{ count: number }>("SELECT COUNT(*)::int AS count FROM queue_outbox WHERE status='pending'"),
  ]);
  const heartbeatAge = heartbeat ? Math.max(0, (Date.now() - Date.parse(heartbeat)) / 1000) : 1e9;
  const queueLines = (prefix: string, counts: Record<string, number>) => [
    metric(`crm_${prefix}_jobs_waiting`, `${prefix} queue waiting jobs`, counts.waiting ?? 0),
    metric(`crm_${prefix}_jobs_active`, `${prefix} queue active jobs`, counts.active ?? 0),
    metric(`crm_${prefix}_jobs_delayed`, `${prefix} queue delayed jobs`, counts.delayed ?? 0),
    metric(`crm_${prefix}_jobs_failed`, `${prefix} queue failed jobs`, counts.failed ?? 0),
  ];
  return [
    metric("crm_database_healthy", "Whether a database query succeeds", 1),
    counter("crm_http_5xx_total", "Total HTTP 5xx responses since process start", http5xxTotal),
    metric("crm_worker_heartbeat_age_seconds", "Seconds since the agent worker heartbeat", heartbeatAge),
    ...queueLines("agent", agent),
    ...queueLines("notification", notification),
    ...queueLines("integration", integration),
    metric("crm_notification_problems", "Failed or uncertain internal notifications", notificationProblems?.count ?? 0),
    metric("crm_orders_at_risk", "Orders marked at risk", riskOrders?.count ?? 0),
    metric("crm_postgres_database_size_bytes", "Current PostgreSQL database size", Number(database?.size ?? 0)),
    metric("crm_queue_outbox_pending", "Transactional queue outbox rows waiting for publication", outboxPending?.count ?? 0),
    `# HELP crm_metrics_generated_timestamp_seconds Metrics generation time\n# TYPE crm_metrics_generated_timestamp_seconds gauge\ncrm_metrics_generated_timestamp_seconds ${Date.parse(now()) / 1000}`,
  ].join("\n") + "\n";
}

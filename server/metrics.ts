import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { all, dbPath, now, one } from "./db.js";

const metric = (name: string, help: string, value: number) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Number.isFinite(value) ? value : 0}`;
const counter = (name: string, help: string, value: number) => `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${Number.isFinite(value) ? value : 0}`;
let http5xxTotal = 0;

export function recordHttpResponse(statusCode: number) {
  if (statusCode >= 500) http5xxTotal += 1;
}

export function productionMetrics() {
  const jobs = all<{ status: string; count: number }>("SELECT status,COUNT(*) AS count FROM agent_jobs GROUP BY status");
  const jobCount = (status: string) => jobs.find((item) => item.status === status)?.count ?? 0;
  const notificationProblems = one<{ count: number }>("SELECT COUNT(*) AS count FROM internal_notifications WHERE status IN ('failed','uncertain')")?.count ?? 0;
  const riskOrders = one<{ count: number }>("SELECT COUNT(*) AS count FROM sales_orders WHERE status='at_risk'")?.count ?? 0;
  const worker = one<{ updated_at: string }>("SELECT updated_at FROM worker_heartbeats WHERE name='agent'");
  const heartbeatAge = worker ? Math.max(0, (Date.now() - Date.parse(worker.updated_at)) / 1000) : 1e9;
  let freeBytes = 0;
  let totalBytes = 0;
  if (dbPath !== ":memory:") {
    const stats = statfsSync(dirname(dbPath));
    freeBytes = stats.bavail * stats.bsize;
    totalBytes = stats.blocks * stats.bsize;
  }
  one("SELECT 1 AS healthy");
  return [
    metric("crm_database_healthy", "Whether a database query succeeds", 1),
    counter("crm_http_5xx_total", "Total HTTP 5xx responses since process start", http5xxTotal),
    metric("crm_worker_heartbeat_age_seconds", "Seconds since the agent worker heartbeat", heartbeatAge),
    metric("crm_agent_jobs_pending", "Pending agent jobs", jobCount("pending")),
    metric("crm_agent_jobs_running", "Running agent jobs", jobCount("running")),
    metric("crm_agent_jobs_failed", "Failed agent jobs", jobCount("failed")),
    metric("crm_notification_problems", "Failed or uncertain internal notifications", notificationProblems),
    metric("crm_orders_at_risk", "Orders marked at risk", riskOrders),
    metric("crm_storage_free_bytes", "Free bytes on the CRM database filesystem", freeBytes),
    metric("crm_storage_total_bytes", "Total bytes on the CRM database filesystem", totalBytes),
    `# HELP crm_metrics_generated_timestamp_seconds Metrics generation time\n# TYPE crm_metrics_generated_timestamp_seconds gauge\ncrm_metrics_generated_timestamp_seconds ${Date.parse(now()) / 1000}`
  ].join("\n") + "\n";
}

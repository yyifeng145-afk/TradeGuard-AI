import assert from "node:assert/strict";
import test from "node:test";

process.env.CRM_DB_PATH = ":memory:";
const { initDatabase, run } = await import("../server/db.js");
const { productionMetrics } = await import("../server/metrics.js");
initDatabase();

test("production metrics expose worker, queue, notification and order risk signals without customer text", () => {
  run("INSERT INTO worker_heartbeats(name,updated_at) VALUES('agent',?)", new Date().toISOString());
  run("UPDATE agent_jobs SET status='failed' WHERE id=(SELECT id FROM agent_jobs LIMIT 1)");
  const output = productionMetrics();
  for (const name of ["crm_database_healthy", "crm_http_5xx_total", "crm_worker_heartbeat_age_seconds", "crm_agent_jobs_failed", "crm_notification_problems", "crm_orders_at_risk", "crm_storage_free_bytes"]) {
    assert.match(output, new RegExp(name));
  }
  assert.doesNotMatch(output, /Acme Imports|English-only|AX-200/);
});

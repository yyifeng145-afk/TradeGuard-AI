import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assertRuntimeConfiguration } from "../server/config.js";

function runScript(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (part: Buffer) => { output += part.toString(); });
    child.stderr.on("data", (part: Buffer) => { output += part.toString(); });
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("production configuration refuses demo storage and insecure model URL", () => {
  assert.throws(() => assertRuntimeConfiguration({ APP_ENV: "production", CRM_DB_PATH: ":memory:" }), /CRM_DB_PATH/);
  assert.throws(() => assertRuntimeConfiguration({ APP_ENV: "production", CRM_DB_PATH: "real.sqlite", CRM_PUBLIC_URL: "http://example.test" }), /HTTPS/);
  assert.throws(() => assertRuntimeConfiguration({ APP_ENV: "production", CRM_DB_PATH: "real.sqlite", CRM_PUBLIC_URL: "https://example.test", MODEL_BASE_URL: "http://example.test", MODEL_API_KEY: "key", MODEL_NAME: "model" }), /模型地址/);
});

test("production bootstraps without demo accounts, provisions team data, and backs up", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crm-production-test-"));
  const dbPath = join(directory, "team.sqlite");
  const backupDir = join(directory, "backups");
  const base = "http://crm.test";
  const env = {
    ...process.env, APP_ENV: "production", CRM_DB_PATH: dbPath, CRM_BACKUP_DIR: backupDir,
    CRM_PUBLIC_URL: "https://crm.example.test", MODEL_BASE_URL: "http://127.0.0.1:9", MODEL_API_KEY: "test-key", MODEL_NAME: "test-model",
    CRM_METRICS_TOKEN: "test-metrics-token-with-at-least-32-characters",
    CRM_BOOTSTRAP_EMAIL: "admin@example.test", CRM_BOOTSTRAP_PASSWORD: "a-long-test-password-123", CRM_BOOTSTRAP_ORGANIZATION: "Example Export Team",
    HOST: "127.0.0.1", PORT: "0", WORKER_ENABLED: "false", FEISHU_BOT_WEBHOOK: "", FEISHU_BOT_SECRET: ""
  };
  let closeApi: (() => Promise<void>) | undefined;
  let closeDatabase: (() => void) | undefined;
  let stopWorker: (() => void) | undefined;
  try {
    const initial = await runScript("server/bootstrap-admin.ts", env);
    assert.equal(initial.code, 0, initial.output);
    const duplicate = await runScript("server/bootstrap-admin.ts", env);
    assert.notEqual(duplicate.code, 0);
    Object.assign(process.env, env);
    const { app } = await import("../server/index.js");
    const { db } = await import("../server/db.js");
    closeDatabase = () => db.close();
    closeApi = () => app.close();
    const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const response = await app.inject({ url: new URL(url).pathname, method: init.method as "GET" | "POST" | "PATCH" | undefined, headers: init.headers, payload: init.body });
      return {
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get: (name: string) => {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value == null ? null : String(value);
        } },
        json: async () => response.json()
      };
    };
    assert.equal((await fetch(`${base}/api/ready`)).status, 503, "API is not ready before the separate worker starts");
    const demoLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "sales@northstar.demo", password: "Demo123!" }) });
    assert.equal(demoLogin.status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@example.test", password: "a-long-test-password-123" }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie") ?? "", /; Secure/);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const csrf = (await login.json() as { csrfToken: string }).csrfToken;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
    const userResponse = await post("/api/admin/users", { name: "Sales One", email: "sales@example.test", role: "sales", password: "another-long-password-123" });
    assert.equal(userResponse.status, 201);
    const salesId = (await userResponse.json() as { id: string }).id;
    const secondUserResponse = await post("/api/admin/users", { name: "Sales Two", email: "sales2@example.test", role: "sales", password: "second-long-password-123" });
    assert.equal(secondUserResponse.status, 201);
    const secondSalesId = (await secondUserResponse.json() as { id: string }).id;
    const firstCustomerResponse = await post("/api/customers", { name: "Overseas Buyer", country: "Germany", industry: "Retail", tier: "A", ownerId: salesId, description: "" });
    assert.equal(firstCustomerResponse.status, 201);
    const firstCustomerId = (await firstCustomerResponse.json() as { id: string }).id;
    const otherCustomerResponse = await post("/api/customers", { name: "Private Buyer", country: "France", industry: "Retail", tier: "B", ownerId: secondSalesId, description: "" });
    assert.equal(otherCustomerResponse.status, 201);
    const otherCustomerId = (await otherCustomerResponse.json() as { id: string }).id;
    assert.equal((await post("/api/products", { sku: "SKU-001", name: "Widget One", category: "Electronics", currency: "USD", listPriceCents: 1250, costCents: 800, moq: 10, leadDays: 20, description: "" })).status, 201);
    assert.equal((await post("/api/policies", { title: "First export policy", version: "v1", maxSalesDiscountBps: 800, minMarginBps: 2000, body: "All formal quotations require human approval." })).status, 201);
    const salesLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "sales@example.test", password: "another-long-password-123" }) });
    assert.equal(salesLogin.status, 200);
    const salesCookie = salesLogin.headers.get("set-cookie")!.split(";")[0];
    const salesCsrf = (await salesLogin.json() as { csrfToken: string }).csrfToken;
    const boot = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: salesCookie } });
    const snapshot = await boot.json() as { customers: unknown[]; products: Array<Record<string, unknown>>; capabilities: { environment: string } };
    assert.equal(snapshot.customers.length, 1);
    assert.equal(snapshot.products.length, 1);
    assert.equal("cost_cents" in snapshot.products[0], false);
    assert.equal(snapshot.capabilities.environment, "production");
    const forbiddenCustomer = await fetch(`${base}/api/customers/${otherCustomerId}`, { headers: { Cookie: salesCookie } });
    assert.equal(forbiddenCustomer.status, 404);
    assert.equal((await post(`/api/admin/users/${secondSalesId}/disable`, {})).status, 409, "customer ownership must be transferred before disabling a user");
    const transfer = await fetch(`${base}/api/customers/${otherCustomerId}/owner`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf }, body: JSON.stringify({ ownerId: salesId }) });
    assert.equal(transfer.status, 200);
    assert.equal((await post(`/api/admin/users/${secondSalesId}/disable`, {})).status, 200);
    const revokedLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "sales2@example.test", password: "second-long-password-123" }) });
    assert.equal(revokedLogin.status, 401);
    const inquiry = await fetch(`${base}/api/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: salesCookie, "X-CSRF-Token": salesCsrf, "Idempotency-Key": "200a09b4-9c3e-4a72-a0d2-9a7696220294" },
      body: JSON.stringify({ customerId: firstCustomerId, text: "Please quote 100 units of SKU-001, FOB Shanghai." })
    });
    assert.equal(inquiry.status, 202);
    const inquiryRunId = (await inquiry.json() as { runId: string }).runId;
    const { startWorker } = await import("../server/engine.js");
    stopWorker = startWorker();
    let workerReady = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await fetch(`${base}/api/ready`)).ok) { workerReady = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(workerReady, true, "API readiness must include the separate worker heartbeat");
    let manualReview = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const detail = await fetch(`${base}/api/runs/${inquiryRunId}`, { headers: { Cookie: salesCookie } });
      const result = await detail.json() as { run: { status: string } };
      if (result.run.status === "needs_manual_review") { manualReview = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(manualReview, true, "model outage must lead to manual review");
    stopWorker();
    stopWorker = undefined;
    const heartbeatDb = new DatabaseSync(dbPath);
    try {
      heartbeatDb.prepare("UPDATE worker_heartbeats SET updated_at=? WHERE name='agent'").run("2020-01-01T00:00:00.000Z");
    } finally {
      heartbeatDb.close();
    }
    assert.equal((await fetch(`${base}/api/ready`)).status, 503, "stale worker heartbeat must make API unready");
    const afterFailure = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: salesCookie } });
    assert.equal(((await afterFailure.json()) as { quotes: unknown[] }).quotes.length, 0);
    const passwordChange = await fetch(`${base}/api/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: salesCookie, "X-CSRF-Token": salesCsrf }, body: JSON.stringify({ currentPassword: "another-long-password-123", newPassword: "fresh-long-password-123" }) });
    assert.equal(passwordChange.status, 200);
    const oldPasswordLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "sales@example.test", password: "another-long-password-123" }) });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "sales@example.test", password: "fresh-long-password-123" }) });
    assert.equal(newPasswordLogin.status, 200);
    for (let attempt = 0; attempt < 5; attempt++) {
      const bad = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "wrong@example.test", password: "wrong" }) });
      assert.equal(bad.status, 401);
    }
    const throttled = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "wrong@example.test", password: "wrong" }) });
    assert.equal(throttled.status, 429);
    const backup = await runScript("server/backup.ts", env);
    assert.equal(backup.code, 0, backup.output);
    const backups = readdirSync(backupDir).filter((name) => name.endsWith(".sqlite"));
    assert.equal(backups.length, 1);
    const restore = await runScript("scripts/restore-drill.ts", env, [join(backupDir, backups[0])]);
    assert.equal(restore.code, 0, restore.output);
    assert.match(restore.output, /"integrity": "ok"/);
  } finally {
    stopWorker?.();
    await closeApi?.();
    closeDatabase?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

import { randomUUID } from "node:crypto";

const base = (process.env.LOAD_BASE_URL ?? "").replace(/\/$/, "");
const email = process.env.LOAD_EMAIL ?? "";
const password = process.env.LOAD_PASSWORD ?? "";
const customerId = process.env.LOAD_CUSTOMER_ID ?? "";
if (process.env.LOAD_CONFIRM_TARGET !== "staging") throw new Error("仅允许在隔离测试环境运行：设置 LOAD_CONFIRM_TARGET=staging");
if (!base || !email || !password || !customerId) throw new Error("LOAD_BASE_URL、LOAD_EMAIL、LOAD_PASSWORD、LOAD_CUSTOMER_ID 均为必填");
const concurrency = Math.min(20, Math.max(1, Number(process.env.LOAD_CONCURRENCY ?? 5)));
const requests = Math.min(10_000, Math.max(1, Number(process.env.LOAD_REQUESTS ?? 100)));
const durationSeconds = Math.min(86_400, Math.max(0, Number(process.env.LOAD_DURATION_SECONDS ?? 0)));
const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`测试账号登录失败：${login.status}`);
const cookie = login.headers.get("set-cookie")!.split(";")[0];
const csrf = (await login.json() as { csrfToken: string }).csrfToken;
let next = 0;
const latencies: number[] = [];
const statuses = new Map<number, number>();
const started = Date.now();
const deadline = durationSeconds > 0 ? started + durationSeconds * 1_000 : Number.POSITIVE_INFINITY;
async function worker() {
  while (true) {
    if (Date.now() >= deadline) return;
    const index = next;
    if (durationSeconds === 0 && index >= requests) return;
    next += 1;
    const started = performance.now();
    const response = await fetch(`${base}/api/messages`, { method: "POST", headers: {
      "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID()
    }, body: JSON.stringify({ customerId, text: `Please quote 1,000 units of LOAD-TEST-SKU, FOB Shanghai. Synthetic load case ${index}.` }) });
    latencies.push(performance.now() - started);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
latencies.sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
const completed = latencies.length;
const report = { completedRequests: completed, requestedRequests: durationSeconds === 0 ? requests : undefined, requestedDurationSeconds: durationSeconds || undefined, concurrency, durationMs: Date.now() - started, statuses: Object.fromEntries(statuses), p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
console.log(JSON.stringify(report, null, 2));
if ((statuses.get(202) ?? 0) !== completed || completed === 0) process.exitCode = 1;

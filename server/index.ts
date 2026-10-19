import Fastify, { type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { all, audit, id, initDatabase, now, one, passwordHash, run, transaction } from "./db.js";
import { isProduction } from "./config.js";
import { assertLoginAllowed, clearSuccessfulLogin, recordFailedLogin } from "./auth.js";
import { createRunForMessage, decideApproval, getRunDetail, recordManualDelivery, retryRun, startWorker } from "./engine.js";
import { runEvaluation } from "./evaluation.js";
import { configuredKnowledgeBase } from "./retrieval.js";
import { syncConfirmedMemory } from "./mem0.js";
import { contentHash } from "./integrity.js";
import { queueInternalNotification, startInternalNotificationWorker } from "./feishu.js";
import { runDetailForSales } from "./run-view.js";
import { recordCustomerResponse, updateOrderStatus } from "./trade.js";
import { productionMetrics, recordHttpResponse } from "./metrics.js";
import { getActivePolicy, getCustomerProfile, listCustomers, searchProducts, type DomainActor } from "./domain.js";
import { runPiOpportunityAnalysis } from "./pi-runtime.js";

type User = { id: string; organization_id: string; name: string; email: string; role: "sales" | "manager" | "finance" | "admin" | "auditor"; password_salt: string; password_hash: string; is_active: number };
type Session = User & { expires_at: string; csrf_token: string | null };

initDatabase();
if (isProduction()) {
  if (one("SELECT id FROM users WHERE email LIKE '%.demo' LIMIT 1")) throw new Error("生产数据库包含演示账号，拒绝启动");
  if (!one("SELECT id FROM users LIMIT 1")) throw new Error("生产数据库没有管理员，请先运行 pnpm bootstrap:admin");
}
const trustedProxyCidrs = process.env.CRM_TRUSTED_PROXY_CIDRS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
const app = Fastify({
  logger: isProduction() ? { level: "info", redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"] } : false,
  trustProxy: isProduction() && trustedProxyCidrs.length ? trustedProxyCidrs : false,
  bodyLimit: 1_000_000
});
export { app };

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("X-Frame-Options", "DENY");
  if (isProduction()) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  }
  return payload;
});

app.addHook("onResponse", async (_request, reply) => {
  recordHttpResponse(reply.statusCode);
});

function sessionToken(request: FastifyRequest) {
  const cookie = request.headers.cookie ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("crm_session="))?.slice("crm_session=".length);
}

function currentUser(request: FastifyRequest): Session {
  const token = sessionToken(request);
  if (!token) throw Object.assign(new Error("请先登录"), { statusCode: 401 });
  const session = one<Session>(
    "SELECT u.*,s.expires_at,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.is_active=1",
    token, now()
  );
  if (!session) throw Object.assign(new Error("登录已过期"), { statusCode: 401 });
  if (!session.csrf_token) {
    session.csrf_token = id();
    run("UPDATE sessions SET csrf_token=? WHERE id=?", session.csrf_token, token);
  }
  return session;
}

function requireRole(user: User, roles: User["role"][]) {
  if (!roles.includes(user.role)) throw Object.assign(new Error("当前角色无权执行此操作"), { statusCode: 403 });
}

function domainUser(user: User): DomainActor {
  return { id: user.id, organizationId: user.organization_id, role: user.role, source: "user" };
}

function requireCustomerAccess(user: User, customerId: string) {
  const customer = one<{ id: string; owner_id: string | null }>(
    "SELECT id,owner_id FROM customers WHERE id=? AND organization_id=?", customerId, user.organization_id
  );
  if (!customer || (user.role === "sales" && customer.owner_id !== user.id)) {
    throw Object.assign(new Error("客户不存在或无权访问"), { statusCode: 404 });
  }
  return customer;
}

app.setErrorHandler((error, _request, reply) => {
  const code = error instanceof ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
  if (code >= 500) console.error("CRM API error:", error);
  reply.status(code).send({ error: error instanceof ZodError ? "输入格式不正确" : code >= 500 ? "服务器处理失败，请稍后重试" : error instanceof Error ? error.message : String(error) });
});

app.addHook("preHandler", async (request) => {
  if (!request.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(request.method) || request.url === "/api/auth/login") return;
  const session = currentUser(request);
  const provided = request.headers["x-csrf-token"];
  const expected = Buffer.from(session.csrf_token ?? "");
  const received = Buffer.from(typeof provided === "string" ? provided : "");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw Object.assign(new Error("请求缺少有效的 CSRF 校验"), { statusCode: 403 });
});

app.get("/api/health", async () => isProduction() ? { ok: true } : ({
  ok: true,
  worker: process.env.WORKER_ENABLED !== "false",
  mode: process.env.MODEL_BASE_URL && process.env.MODEL_API_KEY && process.env.MODEL_NAME ? "model" : "demo",
  knowledge: process.env.WEKNORA_BASE_URL && process.env.WEKNORA_API_KEY && process.env.WEKNORA_KNOWLEDGE_BASE_MAP ? "weknora+local" : "local"
}));

app.get("/api/ready", async (_request, reply) => {
  try {
    one("SELECT 1 AS ready");
    if (isProduction() && process.env.WORKER_ENABLED === "false") {
      const worker = one<{ updated_at: string }>("SELECT updated_at FROM worker_heartbeats WHERE name='agent'");
      const heartbeatAt = worker ? Date.parse(worker.updated_at) : NaN;
      if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > 60_000) return reply.status(503).send({ ready: false });
    }
    return { ready: true };
  } catch {
    return reply.status(503).send({ ready: false });
  }
});

function requireInternalToken(request: FastifyRequest) {
  const expectedValue = process.env.CRM_METRICS_TOKEN ?? "";
  const providedValue = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = Buffer.from(expectedValue);
  const provided = Buffer.from(providedValue);
  if (!expected.length || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw Object.assign(new Error("内部监控凭据无效"), { statusCode: 401 });
  }
}

app.get("/internal/metrics", async (request, reply) => {
  requireInternalToken(request);
  reply.type("text/plain; version=0.0.4; charset=utf-8");
  return productionMetrics();
});

app.post("/internal/alerts", async (request) => {
  requireInternalToken(request);
  const payload = z.object({ alerts: z.array(z.object({
    status: z.string(), fingerprint: z.string().max(200).optional(),
    labels: z.record(z.string(), z.string()).default({})
  })).max(50) }).parse(request.body);
  const organizations = all<{ id: string }>("SELECT id FROM organizations");
  let queued = 0;
  for (const alert of payload.alerts.filter((item) => item.status === "firing")) {
    const name = (alert.labels.alertname ?? "CRMAlert").slice(0, 80);
    for (const organization of organizations) {
      queueInternalNotification(organization.id, `system:${alert.fingerprint ?? name}:firing`, "system_alert", name);
      queued++;
    }
  }
  return { queued };
});

app.post("/api/auth/login", async (request, reply) => {
  const { email, password } = z.object({ email: z.email(), password: z.string() }).parse(request.body);
  const normalizedEmail = email.toLowerCase();
  assertLoginAllowed(normalizedEmail, request.ip);
  const user = one<User>("SELECT * FROM users WHERE email=?", normalizedEmail);
  const { verifyPassword } = await import("./db.js");
  if (!user || user.is_active !== 1 || !verifyPassword(password, user.password_salt, user.password_hash)) {
    recordFailedLogin(normalizedEmail, request.ip);
    return reply.status(401).send({ error: "邮箱或密码错误" });
  }
  clearSuccessfulLogin(normalizedEmail);
  const token = randomBytes(32).toString("base64url");
  const csrfToken = id();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  run("INSERT INTO sessions(id,user_id,expires_at,csrf_token) VALUES(?,?,?,?)", token, user.id, expiresAt, csrfToken);
  reply.header("Set-Cookie", `crm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${isProduction() ? "; Secure" : ""}`);
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organization_id }, csrfToken };
});

app.post("/api/auth/logout", async (request, reply) => {
  const token = sessionToken(request);
  if (token) run("DELETE FROM sessions WHERE id=?", token);
  reply.header("Set-Cookie", `crm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isProduction() ? "; Secure" : ""}`);
  return { ok: true };
});

app.post("/api/auth/change-password", async (request) => {
  const user = currentUser(request);
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string(), newPassword: z.string().min(16).max(128) }).parse(request.body);
  const { verifyPassword } = await import("./db.js");
  if (!verifyPassword(currentPassword, user.password_salt, user.password_hash)) throw Object.assign(new Error("当前密码不正确"), { statusCode: 403 });
  if (currentPassword === newPassword) throw Object.assign(new Error("新密码不能与旧密码相同"), { statusCode: 400 });
  const salt = randomBytes(16).toString("hex");
  transaction(() => {
    run("UPDATE users SET password_salt=?,password_hash=? WHERE id=? AND organization_id=?", salt, passwordHash(newPassword, salt), user.id, user.organization_id);
    run("DELETE FROM sessions WHERE user_id=? AND id<>?", user.id, sessionToken(request) ?? "");
    audit(user.organization_id, user.id, "user.password_changed", "user", user.id, "密码已更新，其他会话已撤销");
  });
  return { ok: true };
});

app.get("/api/auth/me", async (request) => {
  const user = currentUser(request);
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organization_id }, csrfToken: user.csrf_token };
});

app.get("/api/bootstrap", async (request) => {
  const user = currentUser(request);
  const org = user.organization_id;
  const customers = listCustomers(domainUser(user));
  const quotes = all(`SELECT q.*,c.name AS customer_name,p.sku,p.name AS product_name,r.created_by AS quote_created_by,
    d.channel AS delivery_channel,d.external_reference AS delivery_reference,d.recorded_at AS delivery_recorded_at,
    cr.decision AS customer_decision,cr.channel AS customer_response_channel,cr.external_reference AS customer_response_reference,cr.recorded_at AS customer_response_recorded_at,
    a.id AS approval_id,a.status AS approval_status,a.required_role,a.reason AS approval_reason
    FROM quotes q JOIN customers c ON c.id=q.customer_id JOIN products p ON p.id=q.product_id JOIN agent_runs r ON r.id=q.run_id
    LEFT JOIN approvals a ON a.quote_id=q.id LEFT JOIN manual_deliveries d ON d.quote_id=q.id
    LEFT JOIN quote_customer_responses cr ON cr.quote_id=q.id
    WHERE q.organization_id=? AND (?<>'sales' OR c.owner_id=?) ORDER BY q.created_at DESC LIMIT 50`, org, user.role, user.id);
  const orders = all(`SELECT o.*,c.name AS customer_name,p.sku,p.name AS product_name,u.name AS created_by_name
    FROM sales_orders o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
    JOIN products p ON p.id=o.product_id AND p.organization_id=o.organization_id
    LEFT JOIN users u ON u.id=o.created_by
    WHERE o.organization_id=? AND (?<>'sales' OR c.owner_id=?) ORDER BY o.created_at DESC LIMIT 100`, org, user.role, user.id);
  const runs = all(`SELECT r.*,c.name AS customer_name FROM agent_runs r JOIN customers c ON c.id=r.customer_id
    WHERE r.organization_id=? AND (?<>'sales' OR c.owner_id=?) ORDER BY r.created_at DESC LIMIT 40`, org, user.role, user.id);
  const auditEvents = all("SELECT * FROM audit_events WHERE organization_id=? AND (?<>'sales' OR actor_id=?) ORDER BY created_at DESC LIMIT 40", org, user.role, user.id);
  const evaluations = user.role === "sales" ? [] : all("SELECT * FROM evaluation_runs WHERE organization_id=? ORDER BY created_at DESC LIMIT 5", org);
  const products = searchProducts(domainUser(user), "", false);
  const active = getActivePolicy(domainUser(user));
  const policy = { id: active.id, title: active.title, version: active.version, max_sales_discount_bps: active.max_sales_discount_bps, min_margin_bps: active.min_margin_bps };
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: org },
    organizationName: one<{ name: string }>("SELECT name FROM organizations WHERE id=?", org)?.name ?? "CRM 团队",
    csrfToken: user.csrf_token,
    customers, quotes: user.role === "sales" ? (quotes as Array<Record<string, unknown>>).map((quote) => ({ ...quote, margin_bps: null })) : quotes,
    orders,
    runs, auditEvents, evaluations, products, policy,
    metrics: {
      customers: customers.length,
      activeRuns: (runs as Array<{ status: string }>).filter((item) => ["queued", "running", "awaiting_approval", "dispatch_queued", "manual_delivery_required"].includes(item.status)).length,
      pendingApprovals: (quotes as Array<{ approval_status?: string }>).filter((item) => item.approval_status === "pending").length,
      quoteVolumeCents: (quotes as Array<{ total_cents: number; status: string }>).filter((item) => ["sent", "manual_delivery_recorded"].includes(item.status)).reduce((sum, item) => sum + item.total_cents, 0),
      activeOrders: (orders as Array<{ status: string }>).filter((item) => !["completed", "cancelled"].includes(item.status)).length,
      atRiskOrders: (orders as Array<{ status: string }>).filter((item) => item.status === "at_risk").length,
      orderVolumeCents: (orders as Array<{ total_cents: number; status: string }>).filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + item.total_cents, 0)
    },
    capabilities: {
      model: process.env.MODEL_BASE_URL && process.env.MODEL_API_KEY && process.env.MODEL_NAME ? "connected" : "demo",
      knowledge: process.env.WEKNORA_BASE_URL && process.env.WEKNORA_API_KEY && configuredKnowledgeBase(org) ? "weknora+local" : "local",
      channel: isProduction() ? "manual-intake" : "web-demo",
      environment: isProduction() ? "production" : "development",
      feishu: process.env.FEISHU_BOT_WEBHOOK ? "configured" : "disabled"
    }
  };
});

app.get("/api/customers/:id", async (request) => {
  const user = currentUser(request);
  const { id: customerId } = request.params as { id: string };
  let customer: unknown;
  try { customer = getCustomerProfile(domainUser(user), customerId); }
  catch { throw Object.assign(new Error("客户不存在或无权访问"), { statusCode: 404 }); }
  const conversation = one<{ id: string }>("SELECT id FROM conversations WHERE customer_id=? AND organization_id=? ORDER BY created_at LIMIT 1", customerId, user.organization_id);
  return {
    customer,
    conversation,
    messages: conversation ? all("SELECT * FROM messages WHERE conversation_id=? AND organization_id=? ORDER BY created_at,id", conversation.id, user.organization_id) : [],
    memories: all("SELECT * FROM memories WHERE customer_id=? AND organization_id=? ORDER BY created_at DESC", customerId, user.organization_id),
    runs: all("SELECT * FROM agent_runs WHERE customer_id=? AND organization_id=? ORDER BY created_at DESC LIMIT 20", customerId, user.organization_id)
  };
});

app.post("/api/messages", async (request, reply) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  const { customerId, text } = z.object({ customerId: z.string(), text: z.string().trim().min(1).max(4000) }).parse(request.body);
  requireCustomerAccess(user, customerId);
  const clientRequestId = z.uuid().parse(request.headers["idempotency-key"]);
  const result = createRunForMessage(user.organization_id, user.id, customerId, text, clientRequestId);
  return reply.status(202).send(result);
});

app.get("/api/runs/:id", async (request) => {
  const user = currentUser(request);
  const detail = getRunDetail(user.organization_id, (request.params as { id: string }).id);
  if (!detail) throw Object.assign(new Error("运行记录不存在"), { statusCode: 404 });
  requireCustomerAccess(user, (detail.run as { customer_id: string }).customer_id);
  if (user.role === "sales") return runDetailForSales(detail);
  return detail;
});

app.post("/api/runs/:id/retry", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  const runId = (request.params as { id: string }).id;
  const agentRun = one<{ customer_id: string }>("SELECT customer_id FROM agent_runs WHERE id=? AND organization_id=?", runId, user.organization_id);
  if (!agentRun) throw Object.assign(new Error("运行记录不存在"), { statusCode: 404 });
  requireCustomerAccess(user, agentRun.customer_id);
  return retryRun(user.organization_id, user.id, runId);
});

app.post("/api/approvals/:id/decision", async (request, reply) => {
  const user = currentUser(request);
  requireRole(user, ["manager", "finance", "admin"]);
  const { decision, note } = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(500).default("") }).parse(request.body);
  if (isProduction() && note.trim().length < 5) throw Object.assign(new Error("生产审批必须填写至少 5 字的备注"), { statusCode: 400 });
  const result = decideApproval(user.organization_id, user.id, user.role, (request.params as { id: string }).id, decision, note);
  if (result.decision === "invalidated") return reply.status(409).send({ error: "报价已失效，未执行审批，请重新发起询价" });
  return result;
});

app.post("/api/quotes/:id/manual-delivery", async (request, reply) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  const quoteId = (request.params as { id: string }).id;
  const quote = one<{ customer_id: string }>("SELECT customer_id FROM quotes WHERE id=? AND organization_id=?", quoteId, user.organization_id);
  if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
  requireCustomerAccess(user, quote.customer_id);
  const { channel, externalReference, note } = z.object({
    channel: z.enum(["email", "whatsapp", "other"]),
    externalReference: z.string().trim().min(4).max(200), note: z.string().trim().min(10).max(500)
  }).parse(request.body);
  const result = recordManualDelivery(user.organization_id, user.id, user.role, quoteId, channel, externalReference, note);
  if (result.status === "invalidated") return reply.status(409).send({ error: "报价已失效，不能登记交付" });
  return result;
});

app.post("/api/quotes/:id/customer-response", async (request, reply) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  const quoteId = (request.params as { id: string }).id;
  const quote = one<{ customer_id: string }>("SELECT customer_id FROM quotes WHERE id=? AND organization_id=?", quoteId, user.organization_id);
  if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
  requireCustomerAccess(user, quote.customer_id);
  const input = z.object({
    decision: z.enum(["accepted", "rejected"]),
    channel: z.enum(["email", "whatsapp", "other"]),
    externalReference: z.string().trim().min(4).max(200),
    note: z.string().trim().min(10).max(500)
  }).parse(request.body);
  const result = recordCustomerResponse(user.organization_id, user.id, quoteId, input.decision, input.channel, input.externalReference, input.note);
  return reply.status(result.orderId ? 201 : 200).send(result);
});

app.patch("/api/orders/:id/status", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  const orderId = (request.params as { id: string }).id;
  const order = one<{ customer_id: string }>("SELECT customer_id FROM sales_orders WHERE id=? AND organization_id=?", orderId, user.organization_id);
  if (!order) throw Object.assign(new Error("订单不存在"), { statusCode: 404 });
  requireCustomerAccess(user, order.customer_id);
  const input = z.object({
    status: z.enum(["production", "at_risk", "ready_to_ship", "shipped", "completed", "cancelled"]),
    expectedVersion: z.number().int().positive(),
    note: z.string().trim().min(3).max(500),
    trackingReference: z.string().trim().min(4).max(200).optional()
  }).parse(request.body);
  return updateOrderStatus(user.organization_id, user.id, user.role, orderId, input.status, input.expectedVersion, input.note, input.trackingReference);
});

app.post("/api/customers/:id/memories", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  const customerId = (request.params as { id: string }).id;
  requireCustomerAccess(user, customerId);
  const { content } = z.object({ content: z.string().trim().min(5).max(500) }).parse(request.body);
  const memoryId = id();
  run("INSERT INTO memories(id,organization_id,customer_id,content,confidence,status,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)", memoryId, user.organization_id, customerId, content, 0.5, "candidate", contentHash(content), now());
  audit(user.organization_id, user.id, "memory.candidate_added", "memory", memoryId, "人工新增候选偏好");
  return { id: memoryId, status: "candidate" };
});

app.post("/api/memories/:id/confirm", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  const memoryId = (request.params as { id: string }).id;
  const memory = one<{ customer_id: string; content: string }>("SELECT customer_id,content FROM memories WHERE id=? AND organization_id=? AND status='candidate'", memoryId, user.organization_id);
  if (!memory) throw Object.assign(new Error("记忆不存在或已处理"), { statusCode: 404 });
  requireCustomerAccess(user, memory.customer_id);
  const result = run("UPDATE memories SET status='confirmed',confidence=1 WHERE id=? AND organization_id=? AND status='candidate'", memoryId, user.organization_id);
  if (!result.changes) throw Object.assign(new Error("记忆不存在或已处理"), { statusCode: 404 });
  audit(user.organization_id, user.id, "memory.confirmed", "memory", memoryId, "人工确认客户偏好");
  const sync = await syncConfirmedMemory(user.organization_id, memory.customer_id, memory.content);
  if (sync === "failed") audit(user.organization_id, user.id, "memory.mem0_sync_failed", "memory", memoryId, "本地记忆已确认，外部同步失败");
  return { id: memoryId, status: "confirmed", mem0Sync: sync };
});

app.post("/api/evaluations/run", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["manager", "finance", "admin"]);
  if (isProduction()) throw Object.assign(new Error("演示 Golden Corpus 不适用于生产数据，请使用隔离的评测环境"), { statusCode: 409 });
  const result = await runEvaluation(user.organization_id);
  audit(user.organization_id, user.id, "evaluation.run", "evaluation", result.id, `${result.passed}/${result.total} passed`);
  return result;
});

app.post("/api/opportunities/:id/pi-analysis", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["sales", "manager", "admin"]);
  return runPiOpportunityAnalysis(domainUser(user), (request.params as { id: string }).id);
});

app.get("/api/admin/users", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["admin", "manager"]);
  return all("SELECT id,name,email,role,is_active FROM users WHERE organization_id=? ORDER BY name", user.organization_id);
});

app.post("/api/admin/users/:id/disable", async (request) => {
  const actor = currentUser(request);
  requireRole(actor, ["admin"]);
  const targetId = (request.params as { id: string }).id;
  if (targetId === actor.id) throw Object.assign(new Error("不能禁用当前登录的管理员"), { statusCode: 409 });
  return transaction(() => {
    const target = one<{ id: string; is_active: number }>("SELECT id,is_active FROM users WHERE id=? AND organization_id=?", targetId, actor.organization_id);
    if (!target || target.is_active !== 1) throw Object.assign(new Error("用户不存在或已停用"), { statusCode: 404 });
    if (one("SELECT id FROM customers WHERE organization_id=? AND owner_id=? LIMIT 1", actor.organization_id, targetId)) {
      throw Object.assign(new Error("请先移交该用户负责的客户"), { statusCode: 409 });
    }
    run("UPDATE users SET is_active=0 WHERE id=? AND organization_id=?", targetId, actor.organization_id);
    run("DELETE FROM sessions WHERE user_id=?", targetId);
    audit(actor.organization_id, actor.id, "user.disabled", "user", targetId, "账号已停用，所有会话已撤销");
    return { id: targetId, status: "disabled" };
  });
});

app.get("/api/admin/notifications", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["admin", "manager"]);
  return all("SELECT id,kind,target_id,status,attempt,last_error,created_at,sent_at FROM internal_notifications WHERE organization_id=? ORDER BY created_at DESC LIMIT 50", user.organization_id);
});

app.post("/api/admin/notifications/:id/resolve", async (request) => {
  const user = currentUser(request);
  requireRole(user, ["admin"]);
  const notificationId = (request.params as { id: string }).id;
  const { action, note } = z.object({ action: z.enum(["confirmed_sent", "retry"]), note: z.string().trim().min(10).max(500) }).parse(request.body);
  transaction(() => {
    const changed = run("UPDATE internal_notifications SET status=?,available_at=?,last_error=? WHERE id=? AND organization_id=? AND status IN ('uncertain','failed')",
      action === "confirmed_sent" ? "sent" : "pending", now(), action === "confirmed_sent" ? `人工确认：${note}` : `人工决定重试：${note}`, notificationId, user.organization_id);
    if (!changed.changes) throw Object.assign(new Error("该提醒不需要人工处理"), { statusCode: 409 });
    audit(user.organization_id, user.id, `notification.${action}`, "notification", notificationId, note);
  });
  return { id: notificationId, status: action === "confirmed_sent" ? "sent" : "pending" };
});

app.post("/api/admin/users", async (request, reply) => {
  const actor = currentUser(request);
  requireRole(actor, ["admin"]);
  const input = z.object({
    name: z.string().trim().min(2).max(80), email: z.email().transform((value) => value.toLowerCase()),
    role: z.enum(["sales", "manager", "finance", "admin", "auditor"]), password: z.string().min(16).max(128)
  }).parse(request.body);
  if (one("SELECT id FROM users WHERE email=?", input.email)) throw Object.assign(new Error("邮箱已被使用"), { statusCode: 409 });
  const userId = id();
  const salt = randomBytes(16).toString("hex");
  run("INSERT INTO users(id,organization_id,name,email,role,password_salt,password_hash) VALUES(?,?,?,?,?,?,?)",
    userId, actor.organization_id, input.name, input.email, input.role, salt, passwordHash(input.password, salt));
  audit(actor.organization_id, actor.id, "user.created", "user", userId, `角色 ${input.role}`);
  return reply.status(201).send({ id: userId });
});

app.post("/api/customers", async (request, reply) => {
  const actor = currentUser(request);
  requireRole(actor, ["admin", "manager"]);
  const input = z.object({
    name: z.string().trim().min(2).max(120), country: z.string().trim().min(2).max(80),
    industry: z.string().trim().min(2).max(80), tier: z.enum(["A", "B", "C"]),
    ownerId: z.string().min(1).max(128), description: z.string().trim().max(1000).default("")
  }).parse(request.body);
  if (!one("SELECT id FROM users WHERE id=? AND organization_id=? AND is_active=1 AND role IN ('sales','manager','admin')", input.ownerId, actor.organization_id)) {
    throw Object.assign(new Error("负责人不存在或不属于当前团队"), { statusCode: 400 });
  }
  const customerId = id();
  transaction(() => {
    run("INSERT INTO customers(id,organization_id,name,country,industry,tier,status,owner_id,description,last_contact_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      customerId, actor.organization_id, input.name, input.country, input.industry, input.tier, "active", input.ownerId, input.description, now());
    run("INSERT INTO conversations(id,organization_id,customer_id,channel,created_at) VALUES(?,?,?,?,?)", id(), actor.organization_id, customerId, "web", now());
    audit(actor.organization_id, actor.id, "customer.created", "customer", customerId, "已建立客户档案");
  });
  return reply.status(201).send({ id: customerId });
});

app.patch("/api/customers/:id/owner", async (request) => {
  const actor = currentUser(request);
  requireRole(actor, ["admin", "manager"]);
  const customerId = (request.params as { id: string }).id;
  const { ownerId } = z.object({ ownerId: z.string().min(1).max(128) }).parse(request.body);
  if (!one("SELECT id FROM users WHERE id=? AND organization_id=? AND is_active=1 AND role IN ('sales','manager','admin')", ownerId, actor.organization_id)) {
    throw Object.assign(new Error("新负责人不存在或已停用"), { statusCode: 400 });
  }
  const result = run("UPDATE customers SET owner_id=? WHERE id=? AND organization_id=?", ownerId, customerId, actor.organization_id);
  if (!result.changes) throw Object.assign(new Error("客户不存在"), { statusCode: 404 });
  audit(actor.organization_id, actor.id, "customer.owner_changed", "customer", customerId, `新负责人 ${ownerId}`);
  return { id: customerId, ownerId };
});

app.post("/api/products", async (request, reply) => {
  const actor = currentUser(request);
  requireRole(actor, ["admin", "manager"]);
  const input = z.object({
    sku: z.string().trim().regex(/^[A-Za-z0-9-]{2,30}$/), name: z.string().trim().min(2).max(120),
    category: z.string().trim().min(2).max(80), currency: z.string().regex(/^[A-Z]{3}$/),
    listPriceCents: z.number().int().positive().max(1_000_000_000),
    costCents: z.number().int().nonnegative().max(1_000_000_000),
    moq: z.number().int().positive().max(100_000_000), leadDays: z.number().int().min(0).max(365),
    description: z.string().trim().max(2000).default("")
  }).parse(request.body);
  if (input.costCents >= input.listPriceCents) throw Object.assign(new Error("成本必须低于标价"), { statusCode: 400 });
  if (one("SELECT id FROM products WHERE organization_id=? AND sku=?", actor.organization_id, input.sku)) throw Object.assign(new Error("SKU 已存在"), { statusCode: 409 });
  const productId = id();
  run("INSERT INTO products(id,organization_id,sku,name,category,currency,list_price_cents,cost_cents,moq,lead_days,description) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    productId, actor.organization_id, input.sku, input.name, input.category, input.currency,
    input.listPriceCents, input.costCents, input.moq, input.leadDays, input.description);
  audit(actor.organization_id, actor.id, "product.created", "product", productId, input.sku);
  return reply.status(201).send({ id: productId });
});

app.post("/api/policies", async (request, reply) => {
  const actor = currentUser(request);
  requireRole(actor, ["admin"]);
  const input = z.object({
    title: z.string().trim().min(3).max(120), version: z.string().trim().min(1).max(40),
    maxSalesDiscountBps: z.number().int().min(0).max(9999),
    minMarginBps: z.number().int().min(0).max(9999), body: z.string().trim().min(10).max(4000)
  }).parse(request.body);
  if (one("SELECT id FROM policies WHERE organization_id=? AND version=?", actor.organization_id, input.version)) {
    throw Object.assign(new Error("政策版本已存在"), { statusCode: 409 });
  }
  const policyId = id();
  transaction(() => {
    const stamp = now();
    run("UPDATE policies SET effective_to=? WHERE organization_id=? AND status='published' AND effective_to IS NULL", stamp, actor.organization_id);
    run("INSERT INTO policies(id,organization_id,title,version,status,max_sales_discount_bps,min_margin_bps,effective_from,effective_to,body) VALUES(?,?,?,?,?,?,?,?,?,?)",
      policyId, actor.organization_id, input.title, input.version, "published", input.maxSalesDiscountBps, input.minMarginBps, stamp, null, input.body);
    audit(actor.organization_id, actor.id, "policy.published", "policy", policyId, `版本 ${input.version}`);
  });
  return reply.status(201).send({ id: policyId });
});

app.post("/api/knowledge", async (request, reply) => {
  const actor = currentUser(request);
  requireRole(actor, ["admin", "manager"]);
  const input = z.object({
    title: z.string().trim().min(3).max(120), version: z.string().trim().min(1).max(40),
    productSku: z.string().trim().max(30).nullable().default(null), body: z.string().trim().min(20).max(20_000)
  }).parse(request.body);
  if (input.productSku && !one("SELECT id FROM products WHERE organization_id=? AND sku=?", actor.organization_id, input.productSku)) {
    throw Object.assign(new Error("知识文档关联的 SKU 不存在"), { statusCode: 400 });
  }
  const documentId = id();
  run("INSERT INTO knowledge_documents(id,organization_id,title,version,status,effective_from,effective_to,product_sku,body,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
    documentId, actor.organization_id, input.title, input.version, "published", now(), null, input.productSku, input.body, contentHash(input.body));
  audit(actor.organization_id, actor.id, "knowledge.published", "knowledge", documentId, `版本 ${input.version}`);
  return reply.status(201).send({ id: documentId });
});

const distRoot = resolve("dist");
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
app.get("/*", async (request, reply) => {
  if (!existsSync(resolve(distRoot, "index.html"))) return reply.status(404).send({ error: "前端尚未构建，请使用 pnpm dev" });
  const requested = resolve(distRoot, decodeURIComponent((request.params as { "*": string })["*"] || "index.html"));
  const file = requested === distRoot || !requested.startsWith(distRoot + sep) || !existsSync(requested) ? resolve(distRoot, "index.html") : requested;
  reply.type(mime[extname(file)] ?? "application/octet-stream");
  return reply.send(await readFile(file));
});

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8787);
  if (process.env.WORKER_ENABLED !== "false") {
    startWorker();
    startInternalNotificationWorker();
  }
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
  console.log(`CRM API listening at http://${process.env.HOST ?? "127.0.0.1"}:${port}`);
}

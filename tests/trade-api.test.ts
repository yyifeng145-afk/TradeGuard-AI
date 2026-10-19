import assert from "node:assert/strict";
import test from "node:test";

test("HTTP trade flow converts an accepted quote into a tenant-scoped order", async () => {
  process.env.CRM_DB_PATH = ":memory:";
  process.env.WORKER_ENABLED = "false";
  const { app } = await import("../server/index.js");
  const { workOnce } = await import("../server/engine.js");
  const request = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => app.inject({ url: path, ...init });
  const sessionCookie = (header: string | string[] | undefined) => (Array.isArray(header) ? header[0] : header ?? "").split(";")[0];
  async function login(email: string) {
    const response = await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Demo123!" }) });
    assert.equal(response.statusCode, 200);
    return { cookie: sessionCookie(response.headers["set-cookie"]), csrf: (response.json() as { csrfToken: string }).csrfToken };
  }
  try {
    const sales = await login("sales@northstar.demo");
    const inquiry = await request("/api/messages", { method: "POST", headers: {
      "Content-Type": "application/json", Cookie: sales.cookie, "X-CSRF-Token": sales.csrf,
      "Idempotency-Key": "ae17b085-2f66-4c8c-8971-cce0fe65df52"
    }, body: JSON.stringify({ customerId: "cust_acme", text: "Please quote 1,500 units of AX-200, FOB Shanghai." }) });
    assert.equal(inquiry.statusCode, 202);
    assert.equal(await workOnce(), true);

    const boot = await request("/api/bootstrap", { headers: { Cookie: sales.cookie } });
    let quote = (boot.json() as { quotes: Array<{ id: string; approval_id: string; status: string }> }).quotes[0];
    assert.ok(quote?.approval_id);
    const manager = await login("manager@northstar.demo");
    const approval = await request(`/api/approvals/${quote.approval_id}/decision`, { method: "POST", headers: {
      "Content-Type": "application/json", Cookie: manager.cookie, "X-CSRF-Token": manager.csrf
    }, body: JSON.stringify({ decision: "approved", note: "Approved against current terms" }) });
    assert.equal(approval.statusCode, 200);
    assert.equal(await workOnce(), true);
    quote = (await request("/api/bootstrap", { headers: { Cookie: sales.cookie } })).json<{ quotes: Array<{ id: string; approval_id: string; status: string }> }>().quotes[0];
    assert.equal(quote?.status, "sent");
    const noCsrf = await request(`/api/quotes/${quote.id}/customer-response`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: sales.cookie }, body: "{}" });
    assert.equal(noCsrf.statusCode, 403);
    const accepted = await request(`/api/quotes/${quote.id}/customer-response`, { method: "POST", headers: {
      "Content-Type": "application/json", Cookie: sales.cookie, "X-CSRF-Token": sales.csrf
    }, body: JSON.stringify({ decision: "accepted", channel: "email", externalReference: "reply-message-100", note: "Customer accepted the quotation by email" }) });
    assert.equal(accepted.statusCode, 201);
    const orderId = (accepted.json() as { orderId: string }).orderId;
    const snapshot = await request("/api/bootstrap", { headers: { Cookie: sales.cookie } });
    const order = (snapshot.json() as { orders: Array<{ id: string; version: number; status: string }> }).orders[0];
    assert.equal(order.id, orderId);
    const production = await request(`/api/orders/${orderId}/status`, { method: "PATCH", headers: {
      "Content-Type": "application/json", Cookie: sales.cookie, "X-CSRF-Token": sales.csrf
    }, body: JSON.stringify({ status: "production", expectedVersion: order.version, note: "Production work order released" }) });
    assert.equal(production.statusCode, 200);

    const outsider = await login("sales@other.demo");
    const crossTenant = await request(`/api/orders/${orderId}/status`, { method: "PATCH", headers: {
      "Content-Type": "application/json", Cookie: outsider.cookie, "X-CSRF-Token": outsider.csrf
    }, body: JSON.stringify({ status: "at_risk", expectedVersion: 2, note: "Attempted cross tenant update" }) });
    assert.equal(crossTenant.statusCode, 404);
  } finally {
    await app.close();
  }
});

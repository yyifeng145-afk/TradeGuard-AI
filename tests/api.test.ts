import assert from "node:assert/strict";
import test from "node:test";

test("HTTP API enforces CSRF, idempotency, and tenant boundaries", async () => {
  process.env.CRM_DB_PATH = ":memory:";
  process.env.WORKER_ENABLED = "false";
  const { app } = await import("../server/index.js");
  const request = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => app.inject({ url: path, ...init });
  const sessionCookie = (header: string | string[] | undefined) => (Array.isArray(header) ? header[0] : header ?? "").split(";")[0];
  try {
    const login = await request("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sales@northstar.demo", password: "Demo123!" })
    });
    assert.equal(login.statusCode, 200);
    const cookie = sessionCookie(login.headers["set-cookie"]);
    const { csrfToken } = login.json() as { csrfToken: string };
    assert.ok(csrfToken);

    const payload = JSON.stringify({ customerId: "cust_acme", text: "Please quote 1,500 units of AX-200, FOB Shanghai." });
    const noToken = await request("/api/messages", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: payload });
    assert.equal(noToken.statusCode, 403);
    const noKey = await request("/api/messages", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: payload });
    assert.equal(noKey.statusCode, 400);
    const key = "1b209a4d-5a66-4bdb-910e-ecb32d6db432";
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": key };
    const first = await request("/api/messages", { method: "POST", headers, body: payload });
    assert.equal(first.statusCode, 202);
    const firstResult = first.json() as { runId: string };
    const second = await request("/api/messages", { method: "POST", headers, body: payload });
    assert.equal(second.statusCode, 202);
    assert.equal((second.json() as { runId: string }).runId, firstResult.runId);
    const conflict = await request("/api/messages", { method: "POST", headers, body: JSON.stringify({ customerId: "cust_acme", text: "Different inquiry" }) });
    assert.equal(conflict.statusCode, 409);

    const otherLogin = await request("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sales@other.demo", password: "Demo123!" })
    });
    const otherCookie = sessionCookie(otherLogin.headers["set-cookie"]);
    const crossTenant = await request("/api/customers/cust_acme", { headers: { Cookie: otherCookie } });
    assert.equal(crossTenant.statusCode, 404);
  } finally {
    await app.close();
  }
});

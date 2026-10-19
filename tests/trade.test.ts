import assert from "node:assert/strict";
import test from "node:test";

process.env.CRM_DB_PATH = ":memory:";

const { initDatabase, one, run } = await import("../server/db.js");
const { createRunForMessage, decideApproval, workOnce } = await import("../server/engine.js");
const { recordCustomerResponse, updateOrderStatus } = await import("../server/trade.js");

initDatabase();

async function deliveredQuote(customerId = "cust_acme") {
  const { runId } = createRunForMessage("org_northstar", "user_sales", customerId, "Please quote 1,500 units of AX-200, FOB Shanghai.");
  await workOnce();
  const quote = one<{ id: string }>("SELECT id FROM quotes WHERE run_id=?", runId)!;
  const approval = one<{ id: string }>("SELECT id FROM approvals WHERE quote_id=?", quote.id)!;
  decideApproval("org_northstar", "user_manager", "manager", approval.id, "approved", "Approved for standard commercial terms");
  await workOnce();
  return quote.id;
}

test("accepted delivered quote creates one immutable order snapshot", async () => {
  const quoteId = await deliveredQuote();
  const first = recordCustomerResponse("org_northstar", "user_sales", quoteId, "accepted", "email", "customer-email-1001", "Customer accepted the approved quotation by email");
  assert.ok(first.orderId);
  const repeated = recordCustomerResponse("org_northstar", "user_sales", quoteId, "accepted", "email", "customer-email-1001", "Repeated callback payload");
  assert.equal(repeated.orderId, first.orderId);
  const order = one<{ status: string; version: number; quantity: number; total_cents: number }>("SELECT * FROM sales_orders WHERE id=?", first.orderId)!;
  assert.deepEqual({ status: order.status, version: order.version, quantity: order.quantity, total: order.total_cents },
    { status: "confirmed", version: 1, quantity: 1500, total: 1_920_000 });
  assert.throws(() => recordCustomerResponse("org_northstar", "user_sales", quoteId, "rejected", "email", "customer-email-1002", "Conflicting customer response"), /不同的客户结果/);
});

test("order workflow validates transitions, risk notes, tracking and optimistic version", async () => {
  const quoteId = await deliveredQuote("cust_sol");
  const { orderId } = recordCustomerResponse("org_northstar", "user_sales", quoteId, "accepted", "email", "customer-email-2001", "Customer confirmed the order and delivery terms");
  assert.ok(orderId);
  assert.throws(() => updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "shipped", 1, "Ship now", "BL-100"), /不能从/);
  assert.throws(() => updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "at_risk", 1, "late"), /至少 10 字/);
  const risk = updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "at_risk", 1, "Supplier component delay may affect promised date");
  assert.equal(risk.version, 2);
  assert.throws(() => updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "production", 1, "stale browser update"), /刷新后重试/);
  const recovered = updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "ready_to_ship", 2, "Production recovered and quality check passed");
  assert.throws(() => updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "shipped", recovered.version, "Cargo handed over"), /物流或提单编号/);
  const shipped = updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "shipped", recovered.version, "Cargo handed over to forwarder", "BL-2026-001");
  assert.equal(shipped.status, "shipped");
  assert.equal(updateOrderStatus("org_northstar", "user_sales", "sales", orderId!, "completed", shipped.version, "Customer confirmed receipt").status, "completed");
});

test("only managers can cancel and expired quotations cannot become orders", async () => {
  const quoteId = await deliveredQuote("cust_meridian");
  run("UPDATE quotes SET valid_until=? WHERE id=?", "2020-01-01T00:00:00.000Z", quoteId);
  assert.throws(() => recordCustomerResponse("org_northstar", "user_sales", quoteId, "accepted", "email", "customer-email-3001", "Late customer acceptance after quote expiry"), /已过有效期/);
  const rejected = recordCustomerResponse("org_northstar", "user_sales", quoteId, "rejected", "email", "customer-email-3002", "Customer rejected the commercial terms");
  assert.equal(rejected.orderId, null);

  const activeQuote = await deliveredQuote("cust_meridian");
  const accepted = recordCustomerResponse("org_northstar", "user_sales", activeQuote, "accepted", "email", "customer-email-3003", "Customer accepted a fresh approved quotation");
  assert.throws(() => updateOrderStatus("org_northstar", "user_sales", "sales", accepted.orderId!, "cancelled", 1, "Customer requested cancellation"), /经理或管理员/);
  assert.equal(updateOrderStatus("org_northstar", "user_manager", "manager", accepted.orderId!, "cancelled", 1, "Manager verified cancellation request").status, "cancelled");
});

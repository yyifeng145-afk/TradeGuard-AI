import { audit, id, now, one, run, transaction } from "./db.js";
import type { Quote, Role } from "./tools.js";

export type OrderStatus = "confirmed" | "production" | "at_risk" | "ready_to_ship" | "shipped" | "completed" | "cancelled";

type Order = {
  id: string; organization_id: string; quote_id: string; customer_id: string; product_id: string;
  status: OrderStatus; version: number; expected_ship_date: string;
};

const transitions: Record<OrderStatus, OrderStatus[]> = {
  confirmed: ["production", "at_risk", "cancelled"],
  production: ["at_risk", "ready_to_ship", "cancelled"],
  at_risk: ["production", "ready_to_ship", "cancelled"],
  ready_to_ship: ["at_risk", "shipped", "cancelled"],
  shipped: ["completed"],
  completed: [],
  cancelled: []
};

export function recordCustomerResponse(organizationId: string, actorId: string, quoteId: string,
  decision: "accepted" | "rejected", channel: "email" | "whatsapp" | "other", externalReference: string, note: string) {
  return transaction(() => {
    const quote = one<Quote & { lead_days: number }>(`SELECT q.*,p.lead_days FROM quotes q
      JOIN products p ON p.id=q.product_id AND p.organization_id=q.organization_id
      WHERE q.id=? AND q.organization_id=?`, quoteId, organizationId);
    if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
    if (!['sent','manual_delivery_recorded'].includes(quote.status)) {
      throw Object.assign(new Error("报价尚未完成对客交付，不能登记客户结果"), { statusCode: 409 });
    }
    const existing = one<{ id: string; decision: string; channel: string; external_reference: string }>(
      "SELECT id,decision,channel,external_reference FROM quote_customer_responses WHERE quote_id=? AND organization_id=?", quoteId, organizationId
    );
    if (existing) {
      if (existing.decision !== decision || existing.channel !== channel || existing.external_reference !== externalReference) {
        throw Object.assign(new Error("该报价已登记不同的客户结果"), { statusCode: 409 });
      }
      const order = one<Order>("SELECT * FROM sales_orders WHERE quote_id=? AND organization_id=?", quoteId, organizationId);
      return { responseId: existing.id, decision, orderId: order?.id ?? null };
    }
    if (one("SELECT id FROM quote_customer_responses WHERE organization_id=? AND channel=? AND external_reference=?", organizationId, channel, externalReference)) {
      throw Object.assign(new Error("该外部凭据已用于其他报价"), { statusCode: 409 });
    }
    if (decision === "accepted" && (!quote.valid_until || quote.valid_until <= now())) {
      throw Object.assign(new Error("报价已过有效期，不能据此创建订单，请重新报价"), { statusCode: 409 });
    }
    const responseId = id();
    const stamp = now();
    run("INSERT INTO quote_customer_responses(id,organization_id,quote_id,decision,channel,external_reference,note,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)",
      responseId, organizationId, quoteId, decision, channel, externalReference, note, actorId, stamp);
    let orderId: string | null = null;
    if (decision === "accepted") {
      if (!quote.trade_term || !quote.named_place) throw Object.assign(new Error("报价贸易条款不完整，不能创建订单"), { statusCode: 409 });
      orderId = id();
      const expectedShipDate = new Date(Date.now() + quote.lead_days * 24 * 60 * 60 * 1000).toISOString();
      run(`INSERT INTO sales_orders(id,organization_id,quote_id,customer_id,product_id,quantity,currency,unit_price_cents,total_cents,trade_term,named_place,status,version,expected_ship_date,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, orderId, organizationId, quoteId, quote.customer_id, quote.product_id,
      quote.quantity, quote.currency, quote.unit_price_cents, quote.total_cents, quote.trade_term, quote.named_place,
      "confirmed", 1, expectedShipDate, actorId, stamp, stamp);
      run("INSERT INTO order_events(id,organization_id,order_id,from_status,to_status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        id(), organizationId, orderId, null, "confirmed", "客户接受已登记，按获批报价生成订单快照", actorId, stamp);
      audit(organizationId, actorId, "order.created", "order", orderId, `由报价 ${quoteId} 转换`);
    }
    audit(organizationId, actorId, `quote.customer_${decision}`, "quote", quoteId, `${channel} · ${externalReference}`);
    return { responseId, decision, orderId };
  });
}

export function updateOrderStatus(organizationId: string, actorId: string, role: Role, orderId: string,
  targetStatus: OrderStatus, expectedVersion: number, note: string, trackingReference?: string) {
  return transaction(() => {
    const order = one<Order>("SELECT * FROM sales_orders WHERE id=? AND organization_id=?", orderId, organizationId);
    if (!order) throw Object.assign(new Error("订单不存在"), { statusCode: 404 });
    if (order.version !== expectedVersion) throw Object.assign(new Error("订单已被其他成员更新，请刷新后重试"), { statusCode: 409 });
    if (!transitions[order.status].includes(targetStatus)) {
      throw Object.assign(new Error(`订单不能从 ${order.status} 变更为 ${targetStatus}`), { statusCode: 409 });
    }
    if (targetStatus === "cancelled" && !["manager", "admin"].includes(role)) {
      throw Object.assign(new Error("取消订单需要经理或管理员权限"), { statusCode: 403 });
    }
    if (targetStatus === "at_risk" && note.trim().length < 10) {
      throw Object.assign(new Error("标记交期风险时必须填写至少 10 字说明"), { statusCode: 400 });
    }
    if (targetStatus === "shipped" && (!trackingReference || trackingReference.trim().length < 4)) {
      throw Object.assign(new Error("订单出货时必须填写物流或提单编号"), { statusCode: 400 });
    }
    const stamp = now();
    const changed = run(`UPDATE sales_orders SET status=?,version=version+1,tracking_reference=COALESCE(?,tracking_reference),
      risk_note=?,updated_at=? WHERE id=? AND organization_id=? AND version=?`, targetStatus,
    trackingReference?.trim() || null, targetStatus === "at_risk" ? note.trim() : null, stamp, orderId, organizationId, expectedVersion);
    if (!changed.changes) throw Object.assign(new Error("订单已被其他成员更新，请刷新后重试"), { statusCode: 409 });
    run("INSERT INTO order_events(id,organization_id,order_id,from_status,to_status,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id(), organizationId, orderId, order.status, targetStatus, note.trim(), actorId, stamp);
    audit(organizationId, actorId, "order.status_changed", "order", orderId, `${order.status} → ${targetStatus}`);
    return one<Order>("SELECT * FROM sales_orders WHERE id=? AND organization_id=?", orderId, organizationId)!;
  });
}

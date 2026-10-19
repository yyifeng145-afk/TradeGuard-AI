export type User = { id: string; name: string; email: string; role: "sales" | "manager" | "finance" | "admin" | "auditor"; organizationId: string };
export type Customer = {
  id: string; name: string; country: string; industry: string; tier: string;
  status: string; description: string; owner_name: string; last_contact_at: string;
  run_count: number;
};
export type Product = { id: string; sku: string; name: string; category: string; currency: string; list_price_cents: number; moq: number; lead_days: number };
export type Quote = {
  id: string; customer_id: string; customer_name: string; product_name: string; product_id: string; sku: string;
  quantity: number; unit_price_cents: number; total_cents: number; discount_bps: number; margin_bps: number | null;
  currency: string; status: string; version: number; policy_version: string; evidence_json: string;
  trade_term: string | null; named_place: string | null; valid_until: string | null;
  approval_id: string | null; approval_status: string | null; required_role: string | null; approval_reason: string | null;
  run_id: string; created_at: string; quote_created_by: string | null;
  delivery_channel: string | null; delivery_reference: string | null; delivery_recorded_at: string | null;
  customer_decision: "accepted" | "rejected" | null; customer_response_channel: string | null; customer_response_reference: string | null; customer_response_recorded_at: string | null;
};
export type SalesOrder = {
  id: string; quote_id: string; customer_id: string; customer_name: string; product_id: string; product_name: string; sku: string;
  quantity: number; currency: string; unit_price_cents: number; total_cents: number; trade_term: string; named_place: string;
  status: "confirmed" | "production" | "at_risk" | "ready_to_ship" | "shipped" | "completed" | "cancelled";
  version: number; expected_ship_date: string; tracking_reference: string | null; risk_note: string | null;
  created_by_name: string | null; created_at: string; updated_at: string;
};
export type AgentRun = {
  id: string; customer_id: string; customer_name?: string; status: string; mode: string;
  summary: string | null; quote_id: string | null; created_at: string; updated_at: string;
};
export type AgentEvent = { id: string; stage: string; detail: string; created_at: string };
export type ToolCall = { id: string; tool_name: string; risk_level: string; status: string; created_at: string; input_json: string; output_json: string };
export type Memory = { id: string; content: string; confidence: number; status: string; source_message_id: string | null; created_at: string };
export type Message = { id: string; direction: string; body: string; created_at: string };
export type AuditEvent = { id: string; actor_id: string; action: string; target_type: string; target_id: string; detail: string; created_at: string };
export type EvaluationCase = { id: string; title: string; passed: boolean; detail: string };
export type EvaluationRun = { id: string; total: number; passed: number; results_json: string; created_at: string };
export type Bootstrap = {
  user: User;
  organizationName: string;
  csrfToken: string;
  customers: Customer[];
  quotes: Quote[];
  orders: SalesOrder[];
  runs: AgentRun[];
  auditEvents: AuditEvent[];
  evaluations: EvaluationRun[];
  products: Product[];
  policy: { id: string; title: string; version: string; max_sales_discount_bps: number; min_margin_bps: number } | null;
  metrics: { customers: number; activeRuns: number; pendingApprovals: number; quoteVolumeCents: number; activeOrders: number; atRiskOrders: number; orderVolumeCents: number };
  capabilities: { model: string; knowledge: string; channel: string; environment: string; feishu: string };
};
export type CustomerDetail = { customer: Customer; messages: Message[]; memories: Memory[]; runs: AgentRun[] };
export type RunDetail = { run: AgentRun; events: AgentEvent[]; tools: ToolCall[] };

let csrfToken: string | null = null;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && path !== "/api/auth/login" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 || path === "/api/auth/logout") csrfToken = null;
  if (response.ok && typeof body.csrfToken === "string") csrfToken = body.csrfToken;
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}

export const formatMoney = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);

export const formatDate = (value?: string | null) => value
  ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
  : "—";

BEGIN;

CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
  country TEXT NOT NULL, industry TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id), description TEXT NOT NULL, last_contact_at TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id), channel TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id), direction TEXT NOT NULL, body TEXT NOT NULL,
  external_id TEXT, client_request_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(organization_id, external_id)
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), sku TEXT NOT NULL,
  name TEXT NOT NULL, category TEXT NOT NULL, currency TEXT NOT NULL, list_price_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL, moq INTEGER NOT NULL, lead_days INTEGER NOT NULL, description TEXT NOT NULL,
  UNIQUE(organization_id, sku)
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), title TEXT NOT NULL,
  version TEXT NOT NULL, status TEXT NOT NULL, max_sales_discount_bps INTEGER NOT NULL,
  min_margin_bps INTEGER NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), title TEXT NOT NULL,
  version TEXT NOT NULL, status TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
  product_sku TEXT, body TEXT NOT NULL, content_hash TEXT
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id), content TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id), confidence DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL, content_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id), request_message_id TEXT NOT NULL REFERENCES messages(id),
  created_by TEXT REFERENCES users(id), retry_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  mode TEXT NOT NULL, summary TEXT, quote_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id), stage TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id), run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
  product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL, currency TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, discount_bps INTEGER NOT NULL,
  margin_bps INTEGER NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
  policy_id TEXT NOT NULL REFERENCES policies(id), policy_version TEXT NOT NULL, evidence_json TEXT NOT NULL,
  trade_term TEXT, named_place TEXT, valid_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), status TEXT NOT NULL, quote_version INTEGER NOT NULL,
  required_role TEXT NOT NULL, reason TEXT NOT NULL, decided_by TEXT REFERENCES users(id), decision_note TEXT,
  created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), action_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
  body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id), tool_name TEXT NOT NULL, risk_level TEXT NOT NULL,
  input_json TEXT NOT NULL, output_json TEXT NOT NULL, status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), actor_id TEXT NOT NULL,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), total INTEGER NOT NULL,
  passed INTEGER NOT NULL, results_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS internal_notifications (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, target_id TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_outbox (
  id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, job_name TEXT NOT NULL, job_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at TEXT NOT NULL, published_at TEXT
);
CREATE TABLE IF NOT EXISTS manual_deliveries (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), channel TEXT NOT NULL, external_reference TEXT NOT NULL,
  note TEXT NOT NULL, recorded_by TEXT NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL,
  UNIQUE(organization_id, channel, external_reference)
);
CREATE TABLE IF NOT EXISTS quote_customer_responses (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), decision TEXT NOT NULL, channel TEXT NOT NULL,
  external_reference TEXT NOT NULL, note TEXT NOT NULL, recorded_by TEXT NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL, UNIQUE(organization_id, channel, external_reference)
);
CREATE TABLE IF NOT EXISTS sales_orders (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL, currency TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, trade_term TEXT NOT NULL,
  named_place TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  expected_ship_date TEXT NOT NULL, tracking_reference TEXT, risk_note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  order_id TEXT NOT NULL REFERENCES sales_orders(id), from_status TEXT, to_status TEXT NOT NULL,
  note TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id), owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL,
  estimated_value_cents INTEGER, version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opportunity_claims (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id), field_name TEXT NOT NULL, value_json TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  source_version TEXT, content_hash TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(opportunity_id, field_name, source_type, source_id, source_version)
);
CREATE TABLE IF NOT EXISTS opportunity_conflicts (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id), field_name TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL, status TEXT NOT NULL, resolution_json TEXT,
  resolved_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE(opportunity_id, field_name, status)
);
CREATE TABLE IF NOT EXISTS opportunity_reports (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id), report_version INTEGER NOT NULL,
  status TEXT NOT NULL, summary_json TEXT NOT NULL, markdown TEXT NOT NULL, evidence_hash TEXT NOT NULL,
  generator TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(opportunity_id, report_version)
);
CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id), assignee_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expert_runs (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  agent_run_id TEXT REFERENCES agent_runs(id), opportunity_id TEXT REFERENCES opportunities(id),
  expert_name TEXT NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT,
  error TEXT, token_input INTEGER, token_output INTEGER, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  run_id TEXT REFERENCES agent_runs(id), purpose TEXT NOT NULL, provider_model TEXT NOT NULL,
  status TEXT NOT NULL, duration_ms INTEGER NOT NULL, token_input INTEGER, token_output INTEGER,
  cost_microusd INTEGER, error_code TEXT, created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(organization_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_request ON messages(organization_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_customer ON agent_runs(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_outbox_pending ON queue_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON sales_orders(organization_id, customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_events ON order_events(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_customer ON opportunities(organization_id, customer_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_opportunity_claims ON opportunity_claims(opportunity_id, field_name, created_at);
CREATE INDEX IF NOT EXISTS idx_expert_runs ON expert_runs(opportunity_id, started_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_run ON model_calls(run_id, created_at);

COMMIT;

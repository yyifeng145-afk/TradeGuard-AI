import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { isProduction } from "./config.js";
import { assertRuntimeConfiguration } from "./config.js";
import { contentHash } from "./integrity.js";

export type SqlValue = string | number | null;
export const now = () => new Date().toISOString();
export const id = () => randomUUID();

assertRuntimeConfiguration();
const configuredPath = process.env.CRM_DB_PATH || "./data/crm.db";
export const dbPath = configuredPath === ":memory:" ? ":memory:" : resolve(configuredPath);
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

export function one<T>(sql: string, ...args: SqlValue[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}

export function all<T>(sql: string, ...args: SqlValue[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}

export function run(sql: string, ...args: SqlValue[]) {
  return db.prepare(sql).run(...args);
}

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function passwordHash(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password: string, salt: string, hash: string) {
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL,
      csrf_token TEXT
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL, country TEXT NOT NULL, industry TEXT NOT NULL,
      tier TEXT NOT NULL, status TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
      description TEXT NOT NULL, last_contact_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id), channel TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL, body TEXT NOT NULL, external_id TEXT,
      client_request_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      sku TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
      currency TEXT NOT NULL, list_price_cents INTEGER NOT NULL,
      cost_cents INTEGER NOT NULL, moq INTEGER NOT NULL, lead_days INTEGER NOT NULL,
      description TEXT NOT NULL, UNIQUE(organization_id, sku)
    );
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      title TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
      max_sales_discount_bps INTEGER NOT NULL, min_margin_bps INTEGER NOT NULL,
      effective_from TEXT NOT NULL, effective_to TEXT,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      title TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
      effective_from TEXT NOT NULL, effective_to TEXT, product_sku TEXT, body TEXT NOT NULL,
      content_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id), content TEXT NOT NULL,
      source_message_id TEXT REFERENCES messages(id), confidence REAL NOT NULL,
      status TEXT NOT NULL, content_hash TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      request_message_id TEXT NOT NULL REFERENCES messages(id),
      created_by TEXT REFERENCES users(id),
      retry_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, mode TEXT NOT NULL, summary TEXT,
      quote_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      run_id TEXT NOT NULL REFERENCES agent_runs(id), stage TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      run_id TEXT NOT NULL REFERENCES agent_runs(id), kind TEXT NOT NULL,
      status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3, available_at TEXT NOT NULL,
      lease_owner TEXT, lease_expires_at TEXT, lease_version INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL,
      UNIQUE(run_id, kind)
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id), run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
      product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL,
      currency TEXT NOT NULL, unit_price_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL, discount_bps INTEGER NOT NULL,
      margin_bps INTEGER NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      policy_id TEXT NOT NULL REFERENCES policies(id), policy_version TEXT NOT NULL,
      evidence_json TEXT NOT NULL, trade_term TEXT, named_place TEXT, valid_until TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), status TEXT NOT NULL,
      quote_version INTEGER NOT NULL, required_role TEXT NOT NULL, reason TEXT NOT NULL, decided_by TEXT REFERENCES users(id),
      decision_note TEXT, created_at TEXT NOT NULL, decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      action_key TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES agent_runs(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      run_id TEXT NOT NULL REFERENCES agent_runs(id), tool_name TEXT NOT NULL,
      risk_level TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL,
      status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      actor_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      total INTEGER NOT NULL, passed INTEGER NOT NULL, results_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      scope TEXT NOT NULL, identity TEXT NOT NULL, window_started_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL, PRIMARY KEY(scope, identity)
    );
    CREATE TABLE IF NOT EXISTS internal_notifications (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, target_id TEXT NOT NULL,
      status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
      last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      name TEXT PRIMARY KEY, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manual_deliveries (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), channel TEXT NOT NULL,
      external_reference TEXT NOT NULL, note TEXT NOT NULL,
      recorded_by TEXT NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL,
      UNIQUE(organization_id, channel, external_reference)
    );
    CREATE TABLE IF NOT EXISTS quote_customer_responses (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), decision TEXT NOT NULL,
      channel TEXT NOT NULL, external_reference TEXT NOT NULL, note TEXT NOT NULL,
      recorded_by TEXT NOT NULL REFERENCES users(id), recorded_at TEXT NOT NULL,
      UNIQUE(organization_id, channel, external_reference)
    );
    CREATE TABLE IF NOT EXISTS sales_orders (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
      customer_id TEXT NOT NULL REFERENCES customers(id), product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL, currency TEXT NOT NULL, unit_price_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL, trade_term TEXT NOT NULL, named_place TEXT NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      expected_ship_date TEXT NOT NULL, tracking_reference TEXT, risk_note TEXT,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      order_id TEXT NOT NULL REFERENCES sales_orders(id), from_status TEXT,
      to_status TEXT NOT NULL, note TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id), owner_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
      currency TEXT NOT NULL, estimated_value_cents INTEGER,
      version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunity_claims (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      opportunity_id TEXT NOT NULL REFERENCES opportunities(id), field_name TEXT NOT NULL,
      value_json TEXT NOT NULL, confidence REAL NOT NULL, source_type TEXT NOT NULL,
      source_id TEXT NOT NULL, source_version TEXT, content_hash TEXT,
      status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(opportunity_id,field_name,source_type,source_id,source_version)
    );
    CREATE TABLE IF NOT EXISTS opportunity_conflicts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      opportunity_id TEXT NOT NULL REFERENCES opportunities(id), field_name TEXT NOT NULL,
      claim_ids_json TEXT NOT NULL, status TEXT NOT NULL, resolution_json TEXT,
      resolved_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, resolved_at TEXT,
      UNIQUE(opportunity_id,field_name,status)
    );
    CREATE TABLE IF NOT EXISTS opportunity_reports (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      opportunity_id TEXT NOT NULL REFERENCES opportunities(id), report_version INTEGER NOT NULL,
      status TEXT NOT NULL, summary_json TEXT NOT NULL, markdown TEXT NOT NULL,
      evidence_hash TEXT NOT NULL, generator TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(opportunity_id,report_version)
    );
    CREATE TABLE IF NOT EXISTS follow_up_tasks (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      opportunity_id TEXT NOT NULL REFERENCES opportunities(id), assignee_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expert_runs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      agent_run_id TEXT REFERENCES agent_runs(id), opportunity_id TEXT REFERENCES opportunities(id),
      expert_name TEXT NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL,
      result_json TEXT, error TEXT, token_input INTEGER, token_output INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      run_id TEXT REFERENCES agent_runs(id), purpose TEXT NOT NULL, provider_model TEXT NOT NULL,
      status TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      token_input INTEGER, token_output INTEGER, cost_microusd INTEGER,
      error_code TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(organization_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_customer ON agent_runs(customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_pick ON agent_jobs(status, available_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON sales_orders(organization_id, customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_order_events ON order_events(order_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_opportunities_customer ON opportunities(organization_id,customer_id,updated_at);
    CREATE INDEX IF NOT EXISTS idx_opportunity_claims ON opportunity_claims(opportunity_id,field_name,created_at);
    CREATE INDEX IF NOT EXISTS idx_expert_runs ON expert_runs(opportunity_id,started_at);
    CREATE INDEX IF NOT EXISTS idx_model_calls_run ON model_calls(run_id,created_at);
  `);
  // Serialize migrations across API and Worker processes on the same host.
  transaction(() => {
    for (const [table, column, definition] of [
      ["sessions", "csrf_token", "TEXT"],
      ["messages", "client_request_id", "TEXT"],
      ["quotes", "trade_term", "TEXT"],
      ["quotes", "named_place", "TEXT"],
      ["quotes", "valid_until", "TEXT"],
      ["knowledge_documents", "product_sku", "TEXT"],
      ["knowledge_documents", "content_hash", "TEXT"],
      ["memories", "content_hash", "TEXT"],
      ["tool_calls", "duration_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["users", "is_active", "INTEGER NOT NULL DEFAULT 1"],
      ["agent_runs", "created_by", "TEXT"],
      ["agent_runs", "retry_count", "INTEGER NOT NULL DEFAULT 0"],
      ["quote_customer_responses", "channel", "TEXT NOT NULL DEFAULT 'other'"]
    ]) {
      const columns = all<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_request ON messages(organization_id,client_request_id) WHERE client_request_id IS NOT NULL");
  });
  if (!isProduction()) {
    seedDatabase();
    run("UPDATE knowledge_documents SET product_sku='AX-200' WHERE organization_id='org_northstar' AND id='doc_catalog' AND product_sku IS NULL");
    // Bring the originally seeded demo policy in line with the explicit finance-exception rule.
    run("UPDATE policies SET body=? WHERE id=? AND organization_id=? AND body LIKE ?",
      "销售自行报价折扣不超过 8%；所有正式报价均须人工审批。折扣高于 15% 或毛利率低于 20% 时须财务特批；低于成本的报价禁止生成。不得将未确认的客户偏好当作合同条款。价格以当前已发布价目表为准。",
      "policy_2026q4", "org_northstar", "%毛利率不得低于 20%；高于 15% 的折扣还须财务审批%"
    );
  }
  for (const memory of all<{ id: string; content: string }>("SELECT id,content FROM memories WHERE content_hash IS NULL OR content_hash=''")) {
    run("UPDATE memories SET content_hash=? WHERE id=?", contentHash(memory.content), memory.id);
  }
  for (const document of all<{ id: string; body: string }>("SELECT id,body FROM knowledge_documents WHERE content_hash IS NULL OR content_hash=''")) {
    run("UPDATE knowledge_documents SET content_hash=? WHERE id=?", contentHash(document.body), document.id);
  }
}

function seedDatabase() {
  if (one<{ id: string }>("SELECT id FROM organizations LIMIT 1")) return;
  transaction(() => {
    run("INSERT INTO organizations(id,name) VALUES(?,?)", "org_northstar", "Northstar Export Group");
    run("INSERT INTO organizations(id,name) VALUES(?,?)", "org_other", "Other Tenant");
    const salt = randomBytes(16).toString("hex");
    const hash = passwordHash("Demo123!", salt);
    for (const [uid, name, email, role, org] of [
      ["user_sales", "林悦", "sales@northstar.demo", "sales", "org_northstar"],
      ["user_manager", "陈经理", "manager@northstar.demo", "manager", "org_northstar"],
      ["user_finance", "周财务", "finance@northstar.demo", "finance", "org_northstar"],
      ["user_other", "其他租户", "sales@other.demo", "sales", "org_other"]
    ]) {
      run("INSERT INTO users(id,organization_id,name,email,role,password_salt,password_hash) VALUES(?,?,?,?,?,?,?)", uid, org, name, email, role, salt, hash);
    }
    const customers = [
      ["cust_acme", "Acme Imports", "美国", "跨境零售", "A", "重点跟进", "主要采购消费电子配件，重视包装和交期。"],
      ["cust_meridian", "Meridian Trading", "德国", "工业分销", "B", "报价中", "工业零件分销商，对认证文件要求严格。"],
      ["cust_sol", "Sol Retail", "阿联酋", "渠道零售", "B", "待跟进", "新客户，正在评估首批订单。"]
    ];
    for (const [cid, name, country, industry, tier, status, description] of customers) {
      run("INSERT INTO customers(id,organization_id,name,country,industry,tier,status,owner_id,description,last_contact_at) VALUES(?,?,?,?,?,?,?,?,?,?)", cid, "org_northstar", name, country, industry, tier, status, "user_sales", description, now());
      run("INSERT INTO conversations(id,organization_id,customer_id,channel,created_at) VALUES(?,?,?,?,?)", `conv_${cid}`, "org_northstar", cid, "web", now());
    }
    run("INSERT INTO customers(id,organization_id,name,country,industry,tier,status,owner_id,description,last_contact_at) VALUES(?,?,?,?,?,?,?,?,?,?)", "cust_other", "org_other", "Private Customer", "美国", "制造", "A", "保密", "user_other", "不应被另一租户读取。", now());
    run("INSERT INTO conversations(id,organization_id,customer_id,channel,created_at) VALUES(?,?,?,?,?)", "conv_other", "org_other", "cust_other", "web", now());
    const history = [
      ["msg_seed_1", "conv_cust_acme", "inbound", "We need English-only retail packaging for all shipments. Please remember this preference."],
      ["msg_seed_2", "conv_cust_acme", "outbound", "Noted. We will use English-only packaging in future quotations."],
      ["msg_seed_3", "conv_cust_meridian", "inbound", "Please include CE certification and technical sheets with the next quotation."]
    ];
    for (const [mid, conv, direction, body] of history) {
      run("INSERT INTO messages(id,organization_id,conversation_id,direction,body,created_at) VALUES(?,?,?,?,?,?)", mid, "org_northstar", conv, direction, body, now());
    }
    run("INSERT INTO memories(id,organization_id,customer_id,content,source_message_id,confidence,status,created_at) VALUES(?,?,?,?,?,?,?,?)", "mem_packaging", "org_northstar", "cust_acme", "客户要求所有零售包装仅使用英文，不出现中文。", "msg_seed_1", 0.98, "confirmed", now());
    run("INSERT INTO memories(id,organization_id,customer_id,content,source_message_id,confidence,status,created_at) VALUES(?,?,?,?,?,?,?,?)", "mem_terms", "org_northstar", "cust_acme", "客户可能偏好 30 天账期，尚未人工确认。", null, 0.55, "candidate", now());
    for (const [pid, sku, name, category, price, cost, moq, lead, description] of [
      ["prod_ax200", "AX-200", "无线充电模块", "消费电子", 1280, 850, 1000, 21, "15W Qi 兼容无线充电模块，适合零售与 OEM 包装。"],
      ["prod_bx90", "BX-90", "工业连接器", "工业零件", 2460, 1710, 500, 28, "IP67 工业连接器，提供 CE 认证资料。"],
      ["prod_cx10", "CX-10", "智能传感器", "智能硬件", 3980, 2750, 300, 35, "低功耗智能传感器，可批量定制。"]
    ]) {
      run("INSERT INTO products(id,organization_id,sku,name,category,currency,list_price_cents,cost_cents,moq,lead_days,description) VALUES(?,?,?,?,?,?,?,?,?,?,?)", pid, "org_northstar", sku, name, category, "USD", price, cost, moq, lead, description);
    }
    run("INSERT INTO policies(id,organization_id,title,version,status,max_sales_discount_bps,min_margin_bps,effective_from,effective_to,body) VALUES(?,?,?,?,?,?,?,?,?,?)", "policy_2026q4", "org_northstar", "2026 Q4 出口报价政策", "2026.10", "published", 800, 2000, "2026-10-01T00:00:00.000Z", null, "销售自行报价折扣不超过 8%；所有正式报价均须人工审批。折扣高于 15% 或毛利率低于 20% 时须财务特批；低于成本的报价禁止生成。不得将未确认的客户偏好当作合同条款。价格以当前已发布价目表为准。");
    run("INSERT INTO knowledge_documents(id,organization_id,title,version,status,effective_from,effective_to,product_sku,body) VALUES(?,?,?,?,?,?,?,?,?)", "doc_catalog", "org_northstar", "AX-200 产品手册", "v3.2", "published", "2026-09-01T00:00:00.000Z", null, "AX-200", "AX-200 是 15W Qi 兼容无线充电模块。最小起订量 1,000 件，标准交期 21 天。可提供英文零售包装。");
    run("INSERT INTO knowledge_documents(id,organization_id,title,version,status,effective_from,effective_to,body) VALUES(?,?,?,?,?,?,?,?)", "doc_trade", "org_northstar", "出口贸易与报价条款", "v2.1", "published", "2026-10-01T00:00:00.000Z", null, "正式报价需注明币种、有效期、产品数量与贸易术语。FOB 与 CIF 的运费责任不同，不得在未核实目的港和物流报价时承诺 CIF 总价。");
  });
}

export function audit(organizationId: string, actorId: string, action: string, targetType: string, targetId: string, detail: string) {
  run("INSERT INTO audit_events(id,organization_id,actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?)", id(), organizationId, actorId, action, targetType, targetId, detail, now());
}

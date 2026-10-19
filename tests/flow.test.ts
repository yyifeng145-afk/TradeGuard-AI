import assert from "node:assert/strict";
import test from "node:test";

process.env.CRM_DB_PATH = ":memory:";
process.env.WEKNORA_BASE_URL = "https://weknora.invalid";
process.env.WEKNORA_API_KEY = "test-key";
process.env.WEKNORA_KNOWLEDGE_BASE_MAP = JSON.stringify({ org_northstar: "northstar-only" });

const { all, initDatabase, one, run } = await import("../server/db.js");
const { createRunForMessage, decideApproval, getRunDetail, recordManualDelivery, retryRun, workOnce } = await import("../server/engine.js");
const { runEvaluation } = await import("../server/evaluation.js");
const { configuredKnowledgeBase, searchKnowledge } = await import("../server/retrieval.js");
const { searchMem0, syncConfirmedMemory } = await import("../server/mem0.js");
const { invokeTool } = await import("../server/tools.js");
const { contentHash } = await import("../server/integrity.js");

initDatabase();

test("tenant-scoped external retrieval does not call another tenant's KB", async () => {
  assert.equal(configuredKnowledgeBase("org_northstar"), "northstar-only");
  assert.equal(configuredKnowledgeBase("org_other"), undefined);
  const otherResults = await searchKnowledge("org_other", "报价");
  assert.deepEqual(otherResults, []);
  process.env.WEKNORA_BASE_URL = "";
});

test("product-scoped retrieval cannot cite a different SKU manual", async () => {
  const bx = await searchKnowledge("org_northstar", "BX-90 包装 报价", "BX-90");
  assert.ok(bx.some((item) => item.id === "doc_trade"));
  assert.ok(!bx.some((item) => item.id === "doc_catalog"));
  const ax = await searchKnowledge("org_northstar", "AX-200 包装 报价", "AX-200");
  assert.ok(ax.some((item) => item.id === "doc_catalog"));
});

test("high-discount inquiry pauses, requires finance, then sends exactly once", async () => {
  const { runId } = createRunForMessage("org_northstar", "user_sales", "cust_acme", "Need 5,000 units of AX-200 with 20% discount, FOB Los Angeles.");
  assert.equal(await workOnce(), true);
  const detail = getRunDetail("org_northstar", runId)!;
  assert.equal((detail.run as { status: string }).status, "awaiting_approval");
  assert.equal((detail.tools as unknown[]).length, 7);
  assert.ok((detail.tools as Array<{ duration_ms: number }>).every((tool) => tool.duration_ms >= 0));
  const quote = one<{ id: string; total_cents: number; margin_bps: number; evidence_json: string }>("SELECT * FROM quotes WHERE run_id=?", runId)!;
  assert.equal(quote.total_cents, 5_120_000);
  assert.equal(quote.margin_bps, 1699);
  assert.equal((quote as typeof quote & { trade_term: string }).trade_term, "FOB");
  assert.equal((quote as typeof quote & { named_place: string }).named_place, "Los Angeles");
  assert.ok(!quote.evidence_json.includes("mem_terms"), "unconfirmed memory must not be authoritative evidence");
  const approval = one<{ id: string; required_role: string }>("SELECT * FROM approvals WHERE quote_id=?", quote.id)!;
  assert.equal(approval.required_role, "finance");
  assert.throws(() => decideApproval("org_northstar", "user_sales", "sales", approval.id, "approved", "not allowed"));
  assert.throws(() => decideApproval("org_other", "user_other", "admin", approval.id, "approved", "cross tenant"));

  decideApproval("org_northstar", "user_finance", "finance", approval.id, "approved", "Exception approved after margin review");
  assert.equal(await workOnce(), true);
  assert.equal((getRunDetail("org_northstar", runId)!.run as { status: string }).status, "succeeded");
  assert.equal(one<{ status: string }>("SELECT status FROM quotes WHERE id=?", quote.id)?.status, "sent");
  assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE external_id=?", `quote:${quote.id}:v1`)?.count, 1);
  assert.equal(await workOnce(), false);
});

test("the creator cannot approve their own quote even with the required role", async () => {
  const { runId } = createRunForMessage("org_northstar", "user_manager", "cust_sol", "Please quote 1,500 units of AX-200, FOB Shanghai.");
  assert.equal(await workOnce(), true);
  const quote = one<{ id: string }>("SELECT id FROM quotes WHERE run_id=?", runId)!;
  const approval = one<{ id: string }>("SELECT id FROM approvals WHERE quote_id=?", quote.id)!;
  assert.throws(() => decideApproval("org_northstar", "user_manager", "manager", approval.id, "approved", "self-approval"), /创建人不能审批/);
  assert.equal(one<{ status: string }>("SELECT status FROM approvals WHERE id=?", approval.id)?.status, "pending");
  run("UPDATE agent_jobs SET status='done' WHERE run_id=?", runId);
});

test("tool gateway refuses mismatched run/customer and cross-tenant access", async () => {
  const { runId } = createRunForMessage("org_northstar", "user_sales", "cust_meridian", "Please quote 500 units of BX-90 FOB Shanghai.");
  const context = { organizationId: "org_northstar", actorId: "agent_worker", role: "sales" as const, runId };
  await assert.rejects(invokeTool(context, "get_customer_profile", { customerId: "cust_other" }));
  await assert.rejects(invokeTool(context, "get_customer_profile", { customerId: "cust_acme" }), /运行任务不匹配/);
  await assert.rejects(invokeTool(context, "create_quote_draft", {
    customerId: "cust_acme", productId: "prod_bx90", quantity: 500, discountBps: 0, tradeTerm: "FOB", namedPlace: "Shanghai", evidence: []
  }));
  assert.equal(all("SELECT id FROM quotes WHERE run_id=?", runId).length, 0);
  await assert.rejects(invokeTool(context, "create_quote_draft", {
    customerId: "cust_meridian", productId: "prod_bx90", quantity: 500, discountBps: 4000, tradeTerm: "FOB", namedPlace: "Shanghai", evidence: []
  }), /低于成本/);
  const draft = await invokeTool<{ evidence_json: string }>(context, "create_quote_draft", {
    customerId: "cust_meridian", productId: "prod_bx90", quantity: 500, discountBps: 0, tradeTerm: "FOB", namedPlace: "Shanghai",
    evidence: ["memory:mem_terms", "knowledge:stale", "knowledge:doc_catalog@v3.2", "SQL:product:prod_ax200"]
  });
  assert.deepEqual(JSON.parse(draft.evidence_json), ["SQL:product:prod_bx90", "SQL:policy:policy_2026q4@2026.10"]);
  run("UPDATE agent_jobs SET status='done' WHERE run_id=?", runId);
});

test("worker rechecks account status and customer ownership before execution", async () => {
  const disabled = createRunForMessage("org_northstar", "user_sales", "cust_acme", "Please quote 1,500 units of AX-200, FOB Shanghai.");
  run("UPDATE users SET is_active=0 WHERE id='user_sales'");
  try {
    assert.equal(await workOnce(), true);
    assert.equal(one<{ status: string }>("SELECT status FROM agent_runs WHERE id=?", disabled.runId)?.status, "needs_manual_review");
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM quotes WHERE run_id=?", disabled.runId)?.count, 0);
  } finally {
    run("UPDATE users SET is_active=1 WHERE id='user_sales'");
  }

  const transferred = createRunForMessage("org_northstar", "user_sales", "cust_acme", "Please quote 1,500 units of AX-200, FOB Shanghai.");
  run("UPDATE customers SET owner_id='user_manager' WHERE id='cust_acme'");
  try {
    assert.equal(await workOnce(), true);
    assert.equal(one<{ status: string }>("SELECT status FROM agent_runs WHERE id=?", transferred.runId)?.status, "needs_manual_review");
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM quotes WHERE run_id=?", transferred.runId)?.count, 0);
  } finally {
    run("UPDATE customers SET owner_id='user_sales' WHERE id='cust_acme'");
  }
});

test("explicit preference becomes a candidate, never an authoritative quote fact", () => {
  const { messageId } = createRunForMessage("org_northstar", "user_sales", "cust_sol", "Please remember that we prefer English-only packaging.");
  const memory = one<{ status: string; source_message_id: string }>("SELECT status,source_message_id FROM memories WHERE source_message_id=?", messageId);
  assert.equal(memory?.status, "candidate");
  assert.equal(memory?.source_message_id, messageId);
  const agentRun = one<{ id: string }>("SELECT id FROM agent_runs WHERE request_message_id=?", messageId)!;
  run("UPDATE agent_jobs SET status='done' WHERE run_id=?", agentRun.id);
});

test("repeated inquiry key returns the original run and rejects conflicting payloads", () => {
  const key = "a29e9968-7619-40b0-a339-780a55633dea";
  const text = "Please quote 1,500 units of AX-200, FOB Shanghai.";
  const first = createRunForMessage("org_northstar", "user_sales", "cust_sol", text, key);
  const repeated = createRunForMessage("org_northstar", "user_sales", "cust_sol", text, key);
  assert.deepEqual(repeated, first);
  assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE client_request_id=?", key)?.count, 1);
  assert.throws(() => createRunForMessage("org_northstar", "user_sales", "cust_sol", "Changed request", key), /幂等键/);
  run("UPDATE agent_jobs SET status='done' WHERE run_id=?", first.runId);
});

test("approval and dispatch invalidate stale terms or changed policies instead of sending", async () => {
  const expired = createRunForMessage("org_northstar", "user_sales", "cust_sol", "Please quote 1,500 units of AX-200, FOB Shanghai.");
  await workOnce();
  const oldQuote = one<{ id: string }>("SELECT id FROM quotes WHERE run_id=?", expired.runId)!;
  const oldApproval = one<{ id: string }>("SELECT id FROM approvals WHERE quote_id=?", oldQuote.id)!;
  run("UPDATE quotes SET valid_until=? WHERE id=?", "2020-01-01T00:00:00.000Z", oldQuote.id);
  const decision = decideApproval("org_northstar", "user_manager", "manager", oldApproval.id, "approved", "should be blocked");
  assert.equal(decision.decision, "invalidated");
  assert.equal(one<{ status: string }>("SELECT status FROM quotes WHERE id=?", oldQuote.id)?.status, "stale");

  const changed = createRunForMessage("org_northstar", "user_sales", "cust_sol", "Please quote 1,500 units of AX-200, FOB Shanghai.");
  await workOnce();
  const quote = one<{ id: string }>("SELECT id FROM quotes WHERE run_id=?", changed.runId)!;
  const approval = one<{ id: string }>("SELECT id FROM approvals WHERE quote_id=?", quote.id)!;
  decideApproval("org_northstar", "user_manager", "manager", approval.id, "approved", "approved at current policy");
  run("UPDATE policies SET version=? WHERE id=?", "2026.11", "policy_2026q4");
  try {
    await workOnce();
    assert.equal(one<{ status: string }>("SELECT status FROM quotes WHERE id=?", quote.id)?.status, "stale");
    assert.equal(one<{ status: string }>("SELECT status FROM approvals WHERE id=?", approval.id)?.status, "invalidated");
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE external_id=?", `quote:${quote.id}:v1`)?.count, 0);
  } finally {
    run("UPDATE policies SET version=? WHERE id=?", "2026.10", "policy_2026q4");
  }
});

test("approval invalidates a quote when cited knowledge content changes without a version bump", async () => {
  const original = one<{ body: string; content_hash: string }>("SELECT body,content_hash FROM knowledge_documents WHERE id='doc_catalog'")!;
  const created = createRunForMessage("org_northstar", "user_sales", "cust_sol", "Please quote 1,500 units of AX-200, FOB Shanghai.");
  await workOnce();
  const quote = one<{ id: string; evidence_json: string }>("SELECT id,evidence_json FROM quotes WHERE run_id=?", created.runId)!;
  assert.match(quote.evidence_json, /knowledge:doc_catalog@v3\.2#[a-f0-9]{64}/);
  const approval = one<{ id: string }>("SELECT id FROM approvals WHERE quote_id=?", quote.id)!;
  run("UPDATE knowledge_documents SET body=? WHERE id='doc_catalog'", `${original.body} Unauthorized silent edit.`);
  try {
    const decision = decideApproval("org_northstar", "user_manager", "manager", approval.id, "approved", "content changed");
    assert.equal(decision.decision, "invalidated");
    assert.equal(one<{ status: string }>("SELECT status FROM quotes WHERE id=?", quote.id)?.status, "stale");
  } finally {
    run("UPDATE knowledge_documents SET body=?,content_hash=? WHERE id='doc_catalog'", original.body, original.content_hash);
  }
});

test("Mem0 opt-in scopes both search and sync to organization plus customer", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  process.env.MEM0_SYNC_ENABLED = "true";
  process.env.MEM0_API_KEY = "test-only";
  globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ results: [{ id: "external-1", memory: "Prefers English packaging" }] }), { status: 200 });
  };
  try {
    const external = await searchMem0("org_northstar", "cust_acme", "AX-200 packaging");
    assert.equal(external[0]?.status, "unverified");
    assert.equal(await syncConfirmedMemory("org_northstar", "cust_acme", "English-only packaging"), "synced");
    assert.equal(seen.length, 2);
    assert.equal((seen[0].body.filters as { user_id: string }).user_id, "org_northstar:cust_acme");
    assert.equal(seen[1].body.user_id, "org_northstar:cust_acme");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.MEM0_SYNC_ENABLED = "false";
    process.env.MEM0_API_KEY = "";
  }
});

test("Mem0 retrieval requests 50 candidates, removes local duplicates, reranks Top 10 and redacts PII", async () => {
  const originalFetch = globalThis.fetch;
  process.env.MEM0_SYNC_ENABLED = "true";
  process.env.MEM0_API_KEY = "test-only";
  const local = one<{ content: string }>("SELECT content FROM memories WHERE id='mem_packaging'")!.content;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    const results = [
      { id: "duplicate-local", memory: local, score: 1 },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `remote-${index}`,
        memory: index === 0 ? "AX-200 packaging contact buyer@example.com or +1 415 555 1212" : `Preference ${index} for AX-200 packaging`,
        score: 1 - index / 100
      }))
    ];
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  try {
    const external = await searchMem0("org_northstar", "cust_acme", "AX-200 packaging");
    assert.equal(requestBody.limit, 50);
    assert.equal(external.length, 10);
    assert.ok(!external.some((item) => item.id === "duplicate-local"));
    assert.match(external[0].content, /\[EMAIL\]/);
    assert.match(external[0].content, /\[PHONE\]/);
    assert.equal(external[0].contentHash, contentHash("AX-200 packaging contact buyer@example.com or +1 415 555 1212"));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.MEM0_SYNC_ENABLED = "false";
    process.env.MEM0_API_KEY = "";
  }
});

test("Golden Corpus passes deterministic business boundary cases", async () => {
  const result = await runEvaluation("org_northstar");
  assert.equal(result.total, 8);
  assert.equal(result.passed, 8, JSON.stringify(result.cases.filter((item) => !item.passed)));
});

test("production model failure stops at human review without creating a quote", async () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    const { runId } = createRunForMessage("org_northstar", "user_sales", "cust_acme", "Please quote 1,500 units of AX-200, FOB Shanghai.");
    assert.equal(await workOnce(), true);
    assert.equal(one<{ status: string }>("SELECT status FROM agent_runs WHERE id=?", runId)?.status, "needs_manual_review");
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM quotes WHERE run_id=?", runId)?.count, 0);
    assert.match(one<{ output_json: string }>("SELECT output_json FROM tool_calls WHERE run_id=? LIMIT 1", runId)?.output_json ?? "", /redacted/);
    assert.equal(retryRun("org_northstar", "user_sales", runId).status, "queued");
    assert.equal(await workOnce(), true);
    assert.equal(one<{ status: string; retry_count: number }>("SELECT status,retry_count FROM agent_runs WHERE id=?", runId)?.retry_count, 1);
    assert.equal(one<{ status: string }>("SELECT status FROM agent_runs WHERE id=?", runId)?.status, "needs_manual_review");
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});

test("production approval requires manual customer delivery and never creates a demo outbound message", async () => {
  const { runId } = createRunForMessage("org_northstar", "user_sales", "cust_acme", "Please quote 1,500 units of AX-200, FOB Shanghai.");
  assert.equal(await workOnce(), true);
  const quote = one<{ id: string }>("SELECT id FROM quotes WHERE run_id=?", runId)!;
  const approval = one<{ id: string }>("SELECT id FROM approvals WHERE quote_id=?", quote.id)!;
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    decideApproval("org_northstar", "user_manager", "manager", approval.id, "approved", "Reviewed against current policy");
    assert.equal(one<{ status: string }>("SELECT status FROM agent_runs WHERE id=?", runId)?.status, "manual_delivery_required");
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE run_id=?", runId)?.count, 0);
    assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE external_id=?", `quote:${quote.id}:v1`)?.count, 0);
    const recorded = recordManualDelivery("org_northstar", "user_sales", "sales", quote.id, "email", "message-id-1234", "Sent approved quote to the customer by email");
    assert.equal(recorded.status, "manual_delivery_recorded");
    assert.equal(one<{ status: string }>("SELECT status FROM quotes WHERE id=?", quote.id)?.status, "manual_delivery_recorded");
    assert.deepEqual(recordManualDelivery("org_northstar", "user_sales", "sales", quote.id, "email", "message-id-1234", "Same message"), recorded);
    assert.throws(() => recordManualDelivery("org_northstar", "user_sales", "sales", quote.id, "email", "another-message", "Different message"), /已登记/);
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});

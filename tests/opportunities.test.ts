import assert from "node:assert/strict";
import test from "node:test";

process.env.CRM_DB_PATH = ":memory:";

const { initDatabase, one } = await import("../server/db.js");
const {
  createFollowUpTask,
  createOpportunityDraft,
  detectOpportunityConflicts,
  generateOpportunityReport,
  getOpportunity,
  proposeOpportunityClaim
} = await import("../server/opportunities.js");
const { contentHash } = await import("../server/integrity.js");

initDatabase();

const sales = { id: "user_sales", organizationId: "org_northstar", role: "sales" as const, source: "user" as const };
const otherTenant = { id: "user_other", organizationId: "org_other", role: "sales" as const, source: "user" as const };

test("opportunity claims preserve evidence and expose conflicts in the generated report", () => {
  const opportunity = createOpportunityDraft(sales, "cust_acme", "Acme 2027 replenishment", "USD");
  const crmClaim = proposeOpportunityClaim(sales, {
    opportunityId: opportunity.id,
    fieldName: "budget_cents",
    value: 5_000_000,
    confidence: 1,
    sourceType: "crm",
    sourceId: "cust_acme",
    sourceVersion: "customer-v1",
    sourceContent: "confirmed budget: USD 50,000"
  }) as { content_hash: string };
  proposeOpportunityClaim(sales, {
    opportunityId: opportunity.id,
    fieldName: "budget_cents",
    value: 4_500_000,
    confidence: 0.88,
    sourceType: "message",
    sourceId: "msg-budget-2",
    sourceVersion: "1",
    sourceContent: "Our current ceiling is USD 45,000."
  });

  assert.equal(crmClaim.content_hash, contentHash("confirmed budget: USD 50,000"));
  const conflicts = detectOpportunityConflicts(sales, opportunity.id) as Array<{ field_name: string; status: string }>;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field_name, "budget_cents");
  assert.equal(conflicts[0].status, "open");

  const report = generateOpportunityReport(sales, opportunity.id) as { status: string; evidence_hash: string; markdown: string };
  assert.equal(report.status, "needs_review");
  assert.match(report.markdown, /budget_cents/);
  assert.match(report.evidence_hash, /^[a-f0-9]{64}$/);

  const task = createFollowUpTask(sales, opportunity.id, "Confirm latest approved budget", "user_sales") as { status: string };
  assert.equal(task.status, "open");
  assert.equal((getOpportunity(sales, opportunity.id).tasks as unknown[]).length, 1);
  assert.throws(() => getOpportunity(otherTenant, opportunity.id), /无权访问/);
  assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM opportunity_claims WHERE opportunity_id=?", opportunity.id)?.count, 2);
});


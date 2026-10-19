import { all, audit, id, now, one, run, transaction } from "./db.js";
import { contentHash } from "./integrity.js";
import { getCustomerProfile, type DomainActor } from "./domain.js";

export const opportunityStages = ["qualification", "discovery", "proposal", "negotiation", "won", "lost"] as const;
export type OpportunityStage = typeof opportunityStages[number];
type Opportunity = {
  id: string; organization_id: string; customer_id: string; owner_id: string;
  title: string; stage: OpportunityStage; status: string; currency: string;
  estimated_value_cents: number | null; version: number; created_by: string;
  created_at: string; updated_at: string;
};
type Claim = {
  id: string; field_name: string; value_json: string; confidence: number;
  source_type: string; source_id: string; source_version: string | null;
  content_hash: string | null; status: string; created_at: string;
};

function groupClaimsByField(claims: Claim[]) {
  const grouped = new Map<string, Claim[]>();
  for (const claim of claims) {
    const values = grouped.get(claim.field_name) ?? [];
    values.push(claim);
    grouped.set(claim.field_name, values);
  }
  return grouped;
}

const visibleOpportunity = (actor: DomainActor, opportunityId: string) => one<Opportunity>(
  `SELECT o.* FROM opportunities o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
   WHERE o.id=? AND o.organization_id=? AND (?<>'sales' OR c.owner_id=?)`,
  opportunityId, actor.organizationId, actor.role, actor.id
);

export function listOpportunities(actor: DomainActor, customerId?: string) {
  return all<Opportunity>(
    `SELECT o.* FROM opportunities o JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
     WHERE o.organization_id=? AND (? IS NULL OR o.customer_id=?) AND (?<>'sales' OR c.owner_id=?)
     ORDER BY o.updated_at DESC LIMIT 100`,
    actor.organizationId, customerId ?? null, customerId ?? null, actor.role, actor.id
  );
}

export function getOpportunity(actor: DomainActor, opportunityId: string) {
  const opportunity = visibleOpportunity(actor, opportunityId);
  if (!opportunity) throw new Error("商机不存在或无权访问");
  return {
    opportunity,
    claims: all<Claim>("SELECT * FROM opportunity_claims WHERE opportunity_id=? AND organization_id=? ORDER BY field_name,created_at", opportunityId, actor.organizationId),
    conflicts: all("SELECT * FROM opportunity_conflicts WHERE opportunity_id=? AND organization_id=? ORDER BY created_at", opportunityId, actor.organizationId),
    reports: all("SELECT * FROM opportunity_reports WHERE opportunity_id=? AND organization_id=? ORDER BY report_version DESC", opportunityId, actor.organizationId),
    tasks: all("SELECT * FROM follow_up_tasks WHERE opportunity_id=? AND organization_id=? ORDER BY created_at DESC", opportunityId, actor.organizationId)
  };
}

export function createOpportunityDraft(actor: DomainActor, customerId: string, title: string, currency = "USD") {
  const customer = getCustomerProfile(actor, customerId) as { id: string; owner_id: string };
  const stamp = now();
  const opportunityId = id();
  run(`INSERT INTO opportunities(id,organization_id,customer_id,owner_id,title,stage,status,currency,version,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,'qualification','draft',?,1,?,?,?)`,
    opportunityId, actor.organizationId, customer.id, customer.owner_id, title.trim(), currency, actor.id, stamp, stamp);
  audit(actor.organizationId, actor.id, "opportunity.created", "opportunity", opportunityId, title.trim());
  return one<Opportunity>("SELECT * FROM opportunities WHERE id=?", opportunityId)!;
}

export function proposeOpportunityClaim(actor: DomainActor, input: {
  opportunityId: string; fieldName: string; value: unknown; confidence: number;
  sourceType: "crm" | "message" | "memory" | "knowledge" | "model";
  sourceId: string; sourceVersion?: string; sourceContent?: string;
}) {
  const opportunity = visibleOpportunity(actor, input.opportunityId);
  if (!opportunity) throw new Error("商机不存在或无权访问");
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(input.fieldName)) throw new Error("商机字段名不合法");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("置信度必须在 0 到 1 之间");
  const valueJson = JSON.stringify(input.value);
  const claimId = id();
  run(`INSERT OR IGNORE INTO opportunity_claims(id,organization_id,opportunity_id,field_name,value_json,confidence,source_type,source_id,source_version,content_hash,status,created_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,'proposed',?,?)`, claimId, actor.organizationId, opportunity.id, input.fieldName,
    valueJson, input.confidence, input.sourceType, input.sourceId, input.sourceVersion ?? null,
    input.sourceContent ? contentHash(input.sourceContent) : contentHash(valueJson), actor.id, now());
  run("UPDATE opportunities SET version=version+1,updated_at=? WHERE id=?", now(), opportunity.id);
  detectOpportunityConflicts(actor, opportunity.id);
  return one("SELECT * FROM opportunity_claims WHERE opportunity_id=? AND field_name=? AND source_type=? AND source_id=? AND source_version IS ?",
    opportunity.id, input.fieldName, input.sourceType, input.sourceId, input.sourceVersion ?? null);
}

export function detectOpportunityConflicts(actor: DomainActor, opportunityId: string) {
  if (!visibleOpportunity(actor, opportunityId)) throw new Error("商机不存在或无权访问");
  const claims = all<Claim>("SELECT * FROM opportunity_claims WHERE opportunity_id=? AND organization_id=? AND status<>'rejected'", opportunityId, actor.organizationId);
  const grouped = groupClaimsByField(claims);
  return transaction(() => {
    const conflicts: unknown[] = [];
    for (const [fieldName, fieldClaims] of grouped) {
      const values = new Set(fieldClaims.map((claim) => claim.value_json));
      const existing = one<{ id: string }>("SELECT id FROM opportunity_conflicts WHERE opportunity_id=? AND field_name=? AND status='open'", opportunityId, fieldName);
      if (values.size > 1) {
        const conflictId = existing?.id ?? id();
        if (existing) run("UPDATE opportunity_conflicts SET claim_ids_json=? WHERE id=?", JSON.stringify(fieldClaims.map((claim) => claim.id)), conflictId);
        else run("INSERT INTO opportunity_conflicts(id,organization_id,opportunity_id,field_name,claim_ids_json,status,created_at) VALUES(?,?,?,?,?,'open',?)",
          conflictId, actor.organizationId, opportunityId, fieldName, JSON.stringify(fieldClaims.map((claim) => claim.id)), now());
        conflicts.push(one("SELECT * FROM opportunity_conflicts WHERE id=?", conflictId));
      } else if (existing) {
        run("UPDATE opportunity_conflicts SET status='obsolete',resolved_at=? WHERE id=?", now(), existing.id);
      }
    }
    return conflicts;
  });
}

export function generateOpportunityReport(actor: DomainActor, opportunityId: string) {
  const detail = getOpportunity(actor, opportunityId) as { opportunity: Opportunity; claims: Claim[]; conflicts: Array<{ field_name: string; status: string }> };
  const openConflicts = detail.conflicts.filter((conflict) => conflict.status === "open");
  const grouped = groupClaimsByField(detail.claims.filter((claim) => claim.status !== "rejected"));
  const facts = Object.fromEntries(Array.from(grouped, ([field, claims]) => [field, claims.sort((a, b) => b.confidence - a.confidence)[0]]));
  const evidence = detail.claims.map((claim) => ({ id: claim.id, sourceType: claim.source_type, sourceId: claim.source_id, sourceVersion: claim.source_version, contentHash: claim.content_hash }));
  const summary = { opportunityId, stage: detail.opportunity.stage, facts, conflicts: openConflicts, evidence };
  const reportVersion = (one<{ version: number }>("SELECT COALESCE(MAX(report_version),0)+1 AS version FROM opportunity_reports WHERE opportunity_id=?", opportunityId)?.version ?? 1);
  const markdown = [`# ${detail.opportunity.title}`, "", `- 阶段：${detail.opportunity.stage}`, `- 证据字段：${Object.keys(facts).length}`, `- 未解决冲突：${openConflicts.length}`, "", "## 字段结论",
    ...Object.entries(facts).map(([field, claim]) => `- ${field}: ${(claim as Claim).value_json}（来源 ${(claim as Claim).source_type}:${(claim as Claim).source_id}）`),
    "", "## 冲突", ...(openConflicts.length ? openConflicts.map((conflict) => `- ${conflict.field_name}: 需要人工确认`) : ["- 无未解决冲突"])
  ].join("\n");
  const reportId = id();
  run("INSERT INTO opportunity_reports(id,organization_id,opportunity_id,report_version,status,summary_json,markdown,evidence_hash,generator,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    reportId, actor.organizationId, opportunityId, reportVersion, openConflicts.length ? "needs_review" : "ready", JSON.stringify(summary), markdown,
    contentHash(JSON.stringify(evidence)), "deterministic-v1", actor.id, now());
  audit(actor.organizationId, actor.id, "opportunity.report_generated", "opportunity_report", reportId, `version ${reportVersion}`);
  return one("SELECT * FROM opportunity_reports WHERE id=?", reportId)!;
}

export function createFollowUpTask(actor: DomainActor, opportunityId: string, title: string, assigneeId: string, dueAt?: string) {
  if (!visibleOpportunity(actor, opportunityId)) throw new Error("商机不存在或无权访问");
  if (actor.role === "sales" && assigneeId !== actor.id) throw new Error("销售只能给自己创建跟进任务");
  const assignee = one("SELECT id FROM users WHERE id=? AND organization_id=? AND is_active=1", assigneeId, actor.organizationId);
  if (!assignee) throw new Error("跟进任务负责人不存在或已停用");
  const taskId = id();
  const stamp = now();
  run("INSERT INTO follow_up_tasks(id,organization_id,opportunity_id,assignee_id,title,due_at,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',?,?,?)",
    taskId, actor.organizationId, opportunityId, assigneeId, title.trim(), dueAt ?? null, actor.id, stamp, stamp);
  return one("SELECT * FROM follow_up_tasks WHERE id=?", taskId)!;
}

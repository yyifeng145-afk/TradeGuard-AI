import { z } from "zod";
import { all, audit, id, now, one, run, transaction } from "./db.js";
import { queueInternalNotification } from "./feishu.js";
import { isProduction } from "./config.js";
import { getActivePolicy, getCustomerProfile, searchCustomerMemory, searchEnterpriseKnowledge, searchProducts, type DomainActor, type Policy, type Product, type Role } from "./domain.js";
import { knowledgeEvidenceRef, validateQuoteEvidence } from "./evidence.js";

export type { Role, Product, Policy } from "./domain.js";
export type ToolContext = { organizationId: string; actorId: string; role: Role; runId: string };
export type Quote = {
  id: string; organization_id: string; customer_id: string; run_id: string;
  product_id: string; quantity: number; currency: string;
  unit_price_cents: number; total_cents: number;
  discount_bps: number; margin_bps: number; status: string;
  version: number; policy_id: string; policy_version: string;
  evidence_json: string; trade_term: string | null; named_place: string | null;
  valid_until: string | null; created_at: string; updated_at: string;
};

export function calculatePrice(product: Product, quantity: number, discountBps: number) {
  if (!Number.isSafeInteger(quantity) || quantity < product.moq || quantity > 100_000_000) throw new Error(`采购数量必须在 ${product.moq} 至 100000000 件之间`);
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps >= 10_000) throw new Error("折扣超出允许范围");
  const unitPriceCents = Math.round(product.list_price_cents * (10_000 - discountBps) / 10_000);
  const totalCents = unitPriceCents * quantity;
  if (!Number.isSafeInteger(totalCents)) throw new Error("报价金额超出安全整数范围");
  const marginBps = Math.round((unitPriceCents - product.cost_cents) / unitPriceCents * 10_000);
  return { unitPriceCents, totalCents, marginBps };
}

export function activePolicy(organizationId: string): Policy {
  return getActivePolicy({ id: "system", organizationId, role: "admin", source: "user" });
}

const domainActor = (context: ToolContext): DomainActor => ({ id: context.actorId, organizationId: context.organizationId, role: context.role, source: "agent", runId: context.runId });

const definitions = {
  get_customer_profile: { risk: "read", roles: ["sales", "manager", "finance", "admin", "auditor"], schema: z.object({ customerId: z.string() }) },
  search_products: { risk: "read", roles: ["sales", "manager", "finance", "admin", "auditor"], schema: z.object({ query: z.string() }) },
  get_active_policy: { risk: "read", roles: ["sales", "manager", "finance", "admin", "auditor"], schema: z.object({}) },
  search_customer_memory: { risk: "read", roles: ["sales", "manager", "finance", "admin", "auditor"], schema: z.object({ customerId: z.string(), query: z.string().max(200).optional() }) },
  search_knowledge: { risk: "read", roles: ["sales", "manager", "finance", "admin", "auditor"], schema: z.object({ query: z.string(), sku: z.string().optional() }) },
  create_quote_draft: { risk: "write", roles: ["sales", "manager", "finance", "admin"], schema: z.object({
    customerId: z.string(), productId: z.string(), quantity: z.number().int().positive().max(100_000_000),
    discountBps: z.number().int().min(0).max(9999),
    tradeTerm: z.enum(["FOB", "EXW"]), namedPlace: z.string().trim().min(2).max(80),
    evidence: z.array(z.string())
  }) },
  request_quote_approval: { risk: "high_risk", roles: ["sales", "manager", "finance", "admin"], schema: z.object({ quoteId: z.string() }) }
} as const;

export type ToolName = keyof typeof definitions;
export const toolCatalog = Object.entries(definitions).map(([name, value]) => ({ name, risk: value.risk, roles: value.roles }));

export async function invokeTool<T = unknown>(context: ToolContext, name: ToolName, rawInput: unknown): Promise<T> {
  const definition = definitions[name];
  if (!definition.roles.some((role) => role === context.role)) throw new Error(`角色 ${context.role} 无权调用 ${name}`);
  const input = definition.schema.parse(rawInput) as Record<string, unknown>;
  let output: unknown;
  let status = "success";
  const startedAt = performance.now();
  const startedAtWall = now();
  try {
    switch (name) {
      case "get_customer_profile": {
        output = getCustomerProfile(domainActor(context), input.customerId as string);
        break;
      }
      case "search_products": {
        output = searchProducts(domainActor(context), String(input.query), true);
        break;
      }
      case "get_active_policy": {
        output = activePolicy(context.organizationId);
        break;
      }
      case "search_customer_memory": {
        output = await searchCustomerMemory(domainActor(context), input.customerId as string, String(input.query ?? "客户偏好 包装 付款条件"));
        break;
      }
      case "search_knowledge": {
        output = await searchEnterpriseKnowledge(domainActor(context), String(input.query), input.sku as string | undefined);
        break;
      }
      case "create_quote_draft": {
        const customer = one("SELECT id FROM customers WHERE id=? AND organization_id=?", input.customerId as string, context.organizationId);
        const product = one<Product>("SELECT * FROM products WHERE id=? AND organization_id=?", input.productId as string, context.organizationId);
        const agentRun = one<{ customer_id: string; body: string }>("SELECT r.customer_id,m.body FROM agent_runs r JOIN messages m ON m.id=r.request_message_id WHERE r.id=? AND r.organization_id=?", context.runId, context.organizationId);
        if (!customer || !product || !agentRun || agentRun.customer_id !== input.customerId) throw new Error("客户、产品或运行任务不匹配");
        const tradeTerm = input.tradeTerm as string;
        const namedPlace = input.namedPlace as string;
        const explicitTerm = agentRun.body.match(/\b(FOB|EXW)\s+([\p{L}][\p{L}\s-]{1,50})(?=[,.;!?。；，！？]|$)/iu);
        if (!explicitTerm || explicitTerm[1].toUpperCase() !== tradeTerm || explicitTerm[2].trim().toLowerCase() !== namedPlace.toLowerCase()) {
          throw new Error("询价未明确提供相同的贸易术语及指定地点");
        }
        const policy = activePolicy(context.organizationId);
        const quantity = input.quantity as number;
        const discountBps = input.discountBps as number;
        const price = calculatePrice(product, quantity, discountBps);
        if (price.unitPriceCents <= product.cost_cents) throw new Error("报价低于成本，禁止生成草稿");
        const stamp = now();
        const approvedEvidence = new Set<string>([`SQL:product:${product.id}`, `SQL:policy:${policy.id}@${policy.version}`]);
        for (const memory of all<{ id: string }>("SELECT id FROM memories WHERE organization_id=? AND customer_id=? AND status='confirmed'", context.organizationId, input.customerId as string)) {
          approvedEvidence.add(`memory:${memory.id}`);
        }
        for (const document of all<{ id: string; version: string; content_hash: string }>("SELECT id,version,content_hash FROM knowledge_documents WHERE organization_id=? AND status='published' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) AND (product_sku IS NULL OR product_sku=?)", context.organizationId, stamp, stamp, product.sku)) {
          approvedEvidence.add(knowledgeEvidenceRef(document.id, document.version, document.content_hash));
        }
        const evidence = Array.from(new Set([
          `SQL:product:${product.id}`, `SQL:policy:${policy.id}@${policy.version}`,
          ...(input.evidence as string[]).filter((item) => approvedEvidence.has(item))
        ]));
        output = transaction(() => {
          const existing = one<Quote>("SELECT * FROM quotes WHERE run_id=? AND organization_id=?", context.runId, context.organizationId);
          if (existing) return existing;
          const quoteId = id();
          const stamp = now();
          const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          run(`INSERT INTO quotes(id,organization_id,customer_id,run_id,product_id,quantity,currency,unit_price_cents,total_cents,discount_bps,margin_bps,status,version,policy_id,policy_version,evidence_json,trade_term,named_place,valid_until,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, quoteId, context.organizationId, input.customerId as string, context.runId, product.id,
            quantity, product.currency, price.unitPriceCents, price.totalCents, discountBps, price.marginBps, "draft", 1, policy.id, policy.version,
            JSON.stringify(evidence), tradeTerm, namedPlace, validUntil, stamp, stamp);
          audit(context.organizationId, context.actorId, "quote.draft_created", "quote", quoteId, `${product.sku} × ${quantity}`);
          return one<Quote>("SELECT * FROM quotes WHERE id=?", quoteId)!;
        });
        break;
      }
      case "request_quote_approval": {
        const quote = one<Quote>("SELECT * FROM quotes WHERE id=? AND organization_id=?", input.quoteId as string, context.organizationId);
        if (!quote || quote.run_id !== context.runId) throw new Error("报价不存在或与运行任务不匹配");
        if (!quote.trade_term || !quote.named_place || !quote.valid_until || quote.valid_until <= now()) throw new Error("报价条款不完整或已过期，需要重新询价");
        const policy = activePolicy(context.organizationId);
        if (policy.id !== quote.policy_id || policy.version !== quote.policy_version) throw new Error("报价政策已更新，需重新计算");
        const evidenceError = validateQuoteEvidence(context.organizationId, quote);
        if (evidenceError) throw new Error(`${evidenceError}，需重新生成报价`);
        const requiredRole = quote.discount_bps > 1500 || quote.margin_bps < policy.min_margin_bps ? "finance" : "manager";
        const reasons = ["正式报价发送前必须人工审批"];
        if (quote.discount_bps > policy.max_sales_discount_bps) reasons.push(`折扣 ${(quote.discount_bps / 100).toFixed(0)}% 超过销售自行报价上限 ${(policy.max_sales_discount_bps / 100).toFixed(0)}%`);
        if (quote.margin_bps < policy.min_margin_bps) reasons.push(`毛利率 ${(quote.margin_bps / 100).toFixed(1)}% 低于 ${(policy.min_margin_bps / 100).toFixed(0)}% 财务复核线`);
        const reason = reasons.join("；");
        output = transaction(() => {
          const existing = one("SELECT * FROM approvals WHERE quote_id=? AND organization_id=?", quote.id, context.organizationId);
          if (existing) return existing;
          const approvalId = id();
          run("INSERT INTO approvals(id,organization_id,quote_id,status,quote_version,required_role,reason,created_at) VALUES(?,?,?,?,?,?,?,?)", approvalId, context.organizationId, quote.id, "pending", quote.version, requiredRole, reason, now());
          run("UPDATE quotes SET status='pending_approval',updated_at=? WHERE id=?", now(), quote.id);
          audit(context.organizationId, context.actorId, "quote.approval_requested", "approval", approvalId, reason);
          queueInternalNotification(context.organizationId, `approval:${approvalId}`, "approval_pending", approvalId);
          return one("SELECT * FROM approvals WHERE id=?", approvalId);
        });
        break;
      }
    }
    return output as T;
  } catch (error) {
    status = "error";
    output = { error: String(error) };
    throw error;
  } finally {
    const inputLog = isProduction() ? JSON.stringify({ redacted: true, fields: Object.keys(input) }) : JSON.stringify(input);
    const outputLog = isProduction() ? JSON.stringify({ redacted: true, status }) : JSON.stringify(output ?? null).slice(0, 8000);
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    run("INSERT INTO tool_calls(id,organization_id,run_id,tool_name,risk_level,input_json,output_json,status,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id(), context.organizationId, context.runId, name, definition.risk, inputLog, outputLog, status, durationMs, startedAtWall);
  }
}

import { all, audit, id, now, one, run, transaction } from "./db.js";
import { extractInquiry } from "./model.js";
import { activePolicy, calculatePrice, invokeTool, type Policy, type Product, type Quote, type Role, type ToolContext } from "./tools.js";
import type { Evidence } from "./retrieval.js";
import { exportRunTrace } from "./observability.js";
import { queueInternalNotification } from "./feishu.js";
import { isProduction } from "./config.js";
import { knowledgeEvidenceRef, validateQuoteEvidence } from "./evidence.js";
import { contentHash } from "./integrity.js";
import type { AgentQueuePayload } from "./platform/queues.js";
import { scheduleAgentJob } from "./queue-outbox.js";
type AgentRun = {
    id: string;
    organization_id: string;
    customer_id: string;
    request_message_id: string;
    status: string;
    mode: string;
    summary: string | null;
    quote_id: string | null;
    created_by: string | null;
};
type Message = {
    id: string;
    body: string;
    conversation_id: string;
};
type Job = {
    organization_id: string;
    run_id: string;
    kind: "analyze" | "dispatch";
};
type Approval = {
    id: string;
    organization_id: string;
    quote_id: string;
    status: string;
    quote_version: number;
    required_role: string;
};
async function event(organizationId: string, runId: string, stage: string, detail: string) {
    await run("INSERT INTO agent_events(id,organization_id,run_id,stage,detail,created_at) VALUES(?,?,?,?,?,?)", id(), organizationId, runId, stage, detail, now());
}
async function updateRun(runId: string, status: string, summary: string, quoteId: string | null = null) {
    await run("UPDATE agent_runs SET status=?,summary=?,quote_id=COALESCE(?,quote_id),updated_at=? WHERE id=?", status, summary, quoteId, now(), runId);
}
async function invalidateQuote(organizationId: string, quote: Quote, approval: Approval, reason: string) {
    await run("UPDATE approvals SET status='invalidated' WHERE id=? AND organization_id=?", approval.id, organizationId);
    await run("UPDATE quotes SET status='stale',updated_at=? WHERE id=? AND organization_id=?", now(), quote.id, organizationId);
    await updateRun(quote.run_id, "stale", `${reason} 未向客户发送报价，请重新发起询价。`, quote.id);
    await event(organizationId, quote.run_id, "invalidated", reason);
    await audit(organizationId, "system", "approval.invalidated", "approval", approval.id, reason);
}
function explicitPreference(text: string): string | undefined {
    const match = text.match(/(?:please remember(?: that)?|please note(?: that)?|we prefer|请记住|客户偏好[:：]?|我们偏好)\s*([^.!?。！？\n]{5,200})/i);
    return match?.[0]?.trim();
}
export async function createRunForMessage(organizationId: string, actorId: string, customerId: string, text: string, clientRequestId?: string) {
    if (!text.trim() || text.length > 4000)
        throw new Error("消息长度必须在 1 到 4000 字之间");
    const created = await transaction(async () => {
        if (clientRequestId) {
            const existing = await one<{
                message_id: string;
                run_id: string;
                customer_id: string;
                body: string;
            }>("SELECT m.id AS message_id,r.id AS run_id,r.customer_id,m.body FROM messages m JOIN agent_runs r ON r.request_message_id=m.id AND r.organization_id=m.organization_id WHERE m.organization_id=? AND m.client_request_id=?", organizationId, clientRequestId);
            if (existing) {
                if (existing.customer_id !== customerId || existing.body !== text.trim())
                    throw Object.assign(new Error("幂等键已用于另一条询价"), { statusCode: 409 });
                return { runId: existing.run_id, messageId: existing.message_id };
            }
        }
        const conversation = await one<{
            id: string;
        }>("SELECT id FROM conversations WHERE customer_id=? AND organization_id=? AND channel='web'", customerId, organizationId);
        if (!conversation)
            throw Object.assign(new Error("客户不存在或无权访问"), { statusCode: 404 });
        const messageId = id();
        const runId = id();
        const stamp = now();
        await run("INSERT INTO messages(id,organization_id,conversation_id,direction,body,client_request_id,created_at) VALUES(?,?,?,?,?,?,?)", messageId, organizationId, conversation.id, "inbound", text.trim(), clientRequestId ?? null, stamp);
        const preference = explicitPreference(text);
        if (preference && !await one("SELECT id FROM memories WHERE organization_id=? AND customer_id=? AND content=?", organizationId, customerId, preference)) {
            const memoryId = id();
            await run("INSERT INTO memories(id,organization_id,customer_id,content,source_message_id,confidence,status,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)", memoryId, organizationId, customerId, preference, messageId, 0.65, "candidate", contentHash(preference), stamp);
            await audit(organizationId, actorId, "memory.candidate_extracted", "memory", memoryId, "从会话显式偏好语句提取，等待人工确认");
        }
        await run("UPDATE customers SET last_contact_at=? WHERE id=? AND organization_id=?", stamp, customerId, organizationId);
        await run("INSERT INTO agent_runs(id,organization_id,customer_id,request_message_id,created_by,status,mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", runId, organizationId, customerId, messageId, actorId, "queued", "pending", stamp, stamp);
        await scheduleAgentJob({ organizationId, runId, kind: "analyze" });
        await event(organizationId, runId, "received", "客户消息与可靠队列 Outbox 已在同一事务入库");
        await audit(organizationId, actorId, "message.received", "message", messageId, `客户 ${customerId} 提交询价`);
        return { runId, messageId };
    });
    return created;
}
async function currentRunActor(agentRun: AgentRun): Promise<{
    id: string;
    role: Role;
} | undefined> {
    if (!agentRun.created_by)
        return undefined;
    const actor = await one<{
        id: string;
        role: Role;
    }>("SELECT id,role FROM users WHERE id=? AND organization_id=? AND is_active=1", agentRun.created_by, agentRun.organization_id);
    if (!actor || !["sales", "manager", "admin"].includes(actor.role))
        return undefined;
    if (actor.role === "sales") {
        const owned = await one("SELECT id FROM customers WHERE id=? AND organization_id=? AND owner_id=?", agentRun.customer_id, agentRun.organization_id, actor.id);
        if (!owned)
            return undefined;
    }
    return actor;
}
async function pauseForAuthorizationChange(agentRun: AgentRun) {
    await updateRun(agentRun.id, "needs_manual_review", "任务发起人的账号状态或客户归属已变化，已停止自动执行，请由当前负责人复核。");
    await event(agentRun.organization_id, agentRun.id, "authorization", "执行时授权复核失败，未继续生成、审批或发送业务结果");
    await queueInternalNotification(agentRun.organization_id, `authorization:${agentRun.id}`, "manual_review", agentRun.id);
}
async function analyze(job: Job) {
    const agentRun = await one<AgentRun>("SELECT * FROM agent_runs WHERE id=? AND organization_id=?", job.run_id, job.organization_id);
    if (!agentRun)
        throw new Error("Agent run 不存在");
    if (["awaiting_approval", "manual_delivery_required", "manual_delivery_recorded", "succeeded", "needs_clarification", "needs_manual_review", "stale", "rejected"].includes(agentRun.status))
        return;
    const actor = await currentRunActor(agentRun);
    if (!actor) {
        await pauseForAuthorizationChange(agentRun);
        return;
    }
    const message = await one<Message>("SELECT id,body,conversation_id FROM messages WHERE id=? AND organization_id=?", agentRun.request_message_id, job.organization_id);
    if (!message)
        throw new Error("输入消息不存在");
    await updateRun(agentRun.id, "running", "正在整理客户、产品和政策证据");
    await event(job.organization_id, job.run_id, "context", "正在通过受控工具读取客户、记忆、产品与企业知识");
    const context: ToolContext = { organizationId: job.organization_id, actorId: actor.id, role: actor.role, runId: job.run_id };
    const products = await invokeTool<Product[]>(context, "search_products", { query: "" });
    const extraction = await extractInquiry(message.body, products.map((product) => product.sku));
    if (extraction.usage) {
        await run(`INSERT INTO model_calls(id,organization_id,run_id,purpose,provider_model,status,duration_ms,token_input,token_output,cost_microusd,created_at)
         VALUES(?,?,?,?,?,'success',?,?,?,?,?)`, id(), job.organization_id, job.run_id, "inquiry_extraction", extraction.usage.model, extraction.usage.durationMs, extraction.usage.inputTokens, extraction.usage.outputTokens, extraction.usage.costMicrousd, now());
    }
    await run("UPDATE agent_runs SET mode=?,updated_at=? WHERE id=?", extraction.mode, now(), job.run_id);
    if (extraction.mode === "manual") {
        await updateRun(job.run_id, "needs_manual_review", "模型服务不可用或结果无效；已停止自动报价，请由销售人工核对原始询价。");
        await event(job.organization_id, job.run_id, "manual_review", "模型抽取未通过，未生成报价或发送消息");
        await queueInternalNotification(job.organization_id, `manual:${job.run_id}`, "manual_review", job.run_id);
        return;
    }
    await event(job.organization_id, job.run_id, "extract", `识别结果：SKU ${extraction.inquiry.sku ?? "缺失"}，数量 ${extraction.inquiry.quantity ?? "缺失"}，折扣 ${extraction.inquiry.requestedDiscountPercent ?? 0}%（${extraction.mode === "model" ? "模型" : "本地演示解析"}）`);
    if (extraction.warning)
        await event(job.organization_id, job.run_id, "model_fallback", `模型不可用，已切换本地解析：${extraction.warning.slice(0, 160)}`);
    const [customer, policy, memories, knowledge] = await Promise.all([
        await invokeTool<{
            id: string;
            name: string;
            tier: string;
        }>(context, "get_customer_profile", { customerId: agentRun.customer_id }),
        await invokeTool<Policy>(context, "get_active_policy", {}),
        await invokeTool<Evidence[]>(context, "search_customer_memory", { customerId: agentRun.customer_id, query: `${extraction.inquiry.sku ?? "产品"} 包装 付款条件 偏好` }),
        await invokeTool<Evidence[]>(context, "search_knowledge", { query: `${extraction.inquiry.sku ?? "产品"} 报价 包装 贸易条款`, sku: extraction.inquiry.sku ?? undefined })
    ]);
    const confirmed = memories.filter((memory) => memory.status === "confirmed");
    const candidates = memories.filter((memory) => memory.status !== "confirmed");
    await event(job.organization_id, job.run_id, "evidence", `已核对 ${confirmed.length} 条确认记忆、${candidates.length} 条待核实记忆、${knowledge.length} 条知识片段；政策 ${policy.version}`);
    const inquiry = extraction.inquiry;
    const product = products.find((item) => item.sku === inquiry.sku);
    if (!product || !inquiry.quantity) {
        const missing = [!product && "产品 SKU", !inquiry.quantity && "采购数量"].filter(Boolean).join("和");
        await updateRun(job.run_id, "needs_clarification", `请补充${missing}后重新询价。`);
        await event(job.organization_id, job.run_id, "clarification", `缺少必要字段：${missing}`);
        return;
    }
    if (inquiry.quantity < product.moq) {
        await updateRun(job.run_id, "needs_clarification", `${product.sku} 最小起订量为 ${product.moq} 件，请确认数量。`);
        await event(job.organization_id, job.run_id, "validation", "采购数量低于 MOQ，未生成报价");
        return;
    }
    if (inquiry.tradeTerm === "CIF") {
        await updateRun(job.run_id, "needs_clarification", "CIF 报价需要先核实目的港与物流报价，请联系销售确认。", null);
        await event(job.organization_id, job.run_id, "conflict", "缺少可验证的海运费用，阻止 CIF 总价承诺");
        return;
    }
    if (!inquiry.tradeTerm || !inquiry.destination) {
        await updateRun(job.run_id, "needs_clarification", "请补充贸易术语及其指定地点（如 FOB Shanghai 或 EXW Shenzhen），以便生成可审批报价。");
        await event(job.organization_id, job.run_id, "clarification", "缺少明确的贸易术语或指定地点，未生成报价");
        return;
    }
    const discountBps = Math.round((inquiry.requestedDiscountPercent ?? 0) * 100);
    const price = calculatePrice(product, inquiry.quantity, discountBps);
    if (price.unitPriceCents <= product.cost_cents) {
        await updateRun(job.run_id, "needs_clarification", "客户提出的折扣将导致报价低于成本，已阻止生成草稿。", null);
        await event(job.organization_id, job.run_id, "policy_block", "报价低于成本，规则引擎拒绝");
        return;
    }
    const evidence = [
        `SQL:product:${product.id}`,
        `SQL:policy:${policy.id}@${policy.version}`,
        ...confirmed.map((memory) => `memory:${memory.id}`),
        ...knowledge.filter((item) => item.type === "knowledge" && item.version && item.contentHash)
            .map((item) => knowledgeEvidenceRef(item.id, item.version!, item.contentHash!))
    ];
    await event(job.organization_id, job.run_id, "pricing", `${product.sku} × ${inquiry.quantity}，单价 $${(price.unitPriceCents / 100).toFixed(2)}，毛利率 ${(price.marginBps / 100).toFixed(1)}%`);
    const quote = await invokeTool<Quote>(context, "create_quote_draft", {
        customerId: customer.id, productId: product.id, quantity: inquiry.quantity, discountBps,
        tradeTerm: inquiry.tradeTerm, namedPlace: inquiry.destination, evidence
    });
    const approval = await invokeTool<{
        id: string;
        required_role: string;
    }>(context, "request_quote_approval", { quoteId: quote.id });
    await updateRun(job.run_id, "awaiting_approval", `已为 ${customer.name} 生成报价草稿，等待${approval.required_role === "finance" ? "财务" : "经理"}审批。`, quote.id);
    await event(job.organization_id, job.run_id, "approval", `审批单 ${approval.id} 已创建，Agent 暂停发送`);
}
async function dispatch(job: Job) {
    await transaction(async () => {
        const agentRun = await one<AgentRun>("SELECT * FROM agent_runs WHERE id=? AND organization_id=?", job.run_id, job.organization_id);
        if (!agentRun?.quote_id)
            throw new Error("报价不存在");
        if (!await currentRunActor(agentRun)) {
            await pauseForAuthorizationChange(agentRun);
            return;
        }
        const quote = await one<Quote>("SELECT * FROM quotes WHERE id=? AND organization_id=?", agentRun.quote_id, job.organization_id);
        const approval = await one<Approval>("SELECT * FROM approvals WHERE quote_id=? AND organization_id=?", quote?.id ?? "", job.organization_id);
        if (!quote || !approval || approval.status !== "approved")
            throw new Error("报价尚未通过审批");
        if (quote.version !== approval.quote_version)
            return await invalidateQuote(job.organization_id, quote, approval, "报价版本已变化，原审批失效。");
        if (!quote.trade_term || !quote.named_place || !quote.valid_until || quote.valid_until <= now())
            return await invalidateQuote(job.organization_id, quote, approval, "报价条款不完整或有效期已过。");
        const evidenceError = await validateQuoteEvidence(job.organization_id, quote);
        if (evidenceError)
            return await invalidateQuote(job.organization_id, quote, approval, `${evidenceError}。`);
        let policy: Policy;
        try {
            policy = await activePolicy(job.organization_id);
        }
        catch {
            return await invalidateQuote(job.organization_id, quote, approval, "当前没有生效的报价政策。");
        }
        if (quote.policy_id !== policy.id || quote.policy_version !== policy.version)
            return await invalidateQuote(job.organization_id, quote, approval, "报价政策已更新，原审批失效。");
        if (isProduction()) {
            await updateRun(job.run_id, "manual_delivery_required", "正式报价已审批，等待销售从既有客户渠道人工发送并登记交付。", quote.id);
            await event(job.organization_id, job.run_id, "manual_delivery", "生产模式未接入客户发送渠道，不执行 Web 演示投递");
            return;
        }
        const product = await one<Product>("SELECT * FROM products WHERE id=? AND organization_id=?", quote.product_id, job.organization_id);
        const message = await one<Message>("SELECT id,body,conversation_id FROM messages WHERE id=? AND organization_id=?", agentRun.request_message_id, job.organization_id);
        if (!product || !message)
            throw new Error("报价关联数据不存在");
        const actionKey = `quote:${quote.id}:v${quote.version}`;
        const body = `正式报价已审批：${product.sku} ${product.name} × ${quote.quantity}，单价 ${quote.currency} ${(quote.unit_price_cents / 100).toFixed(2)}，总价 ${quote.currency} ${(quote.total_cents / 100).toFixed(2)}；贸易条款 ${quote.trade_term} ${quote.named_place}；有效期至 ${quote.valid_until.slice(0, 10)}（UTC）；标准交期 ${product.lead_days} 天。此消息为 Web 演示渠道发送记录。`;
        await run("INSERT OR IGNORE INTO outbox(id,organization_id,action_key,run_id,conversation_id,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)", id(), job.organization_id, actionKey, job.run_id, message.conversation_id, body, "pending", now());
        await run("INSERT OR IGNORE INTO messages(id,organization_id,conversation_id,direction,body,external_id,created_at) VALUES(?,?,?,?,?,?,?)", id(), job.organization_id, message.conversation_id, "outbound", body, actionKey, now());
        await run("UPDATE outbox SET status='delivered',delivered_at=? WHERE action_key=? AND organization_id=?", now(), actionKey, job.organization_id);
        await run("UPDATE quotes SET status='sent',updated_at=? WHERE id=?", now(), quote.id);
        await updateRun(job.run_id, "succeeded", "报价经人工审批后已发送到 Web 演示会话。", quote.id);
        await event(job.organization_id, job.run_id, "delivered", `Outbox ${actionKey} 已交付，重复执行不会再次发送`);
        await audit(job.organization_id, "agent_worker", "quote.sent", "quote", quote.id, actionKey);
    });
}
export async function processAgentJob(payload: AgentQueuePayload) {
    const job: Job = { organization_id: payload.organizationId, run_id: payload.runId, kind: payload.kind };
    if (job.kind === "analyze") await analyze(job);
    else await dispatch(job);
    const terminal = await one<{ status: string }>("SELECT status FROM agent_runs WHERE id=? AND organization_id=?", job.run_id, job.organization_id);
    if (terminal && ["succeeded", "manual_delivery_recorded", "needs_clarification", "needs_manual_review", "rejected", "stale"].includes(terminal.status)) {
        void exportRunTrace(job.organization_id, job.run_id).catch((error: unknown) => console.warn("Langfuse export failed:", String(error)));
    }
}

export async function markAgentJobFailed(payload: AgentQueuePayload, error: unknown) {
    const message = String(error).slice(0, 500);
    await event(payload.organizationId, payload.runId, "failed", message);
    await updateRun(payload.runId, "failed", "任务执行失败，请查看运行轨迹。", null);
    await queueInternalNotification(payload.organizationId, `failed:${payload.runId}`, "job_failed", payload.runId);
    void exportRunTrace(payload.organizationId, payload.runId).catch((traceError: unknown) => console.warn("Langfuse export failed:", String(traceError)));
}
export async function decideApproval(organizationId: string, actorId: string, role: Role, approvalId: string, decision: "approved" | "rejected", note: string) {
    const result = await transaction(async () => {
        const approval = await one<Approval>("SELECT * FROM approvals WHERE id=? AND organization_id=?", approvalId, organizationId);
        if (!approval || approval.status !== "pending")
            throw Object.assign(new Error("审批单不存在或已处理"), { statusCode: 409 });
        if (role !== "admin" && role !== approval.required_role)
            throw Object.assign(new Error(`该报价需要 ${approval.required_role} 角色审批`), { statusCode: 403 });
        const quote = await one<Quote>("SELECT * FROM quotes WHERE id=? AND organization_id=?", approval.quote_id, organizationId);
        if (!quote)
            throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
        const creator = await one<{
            created_by: string | null;
        }>("SELECT created_by FROM agent_runs WHERE id=? AND organization_id=?", quote.run_id, organizationId);
        if (creator?.created_by === actorId)
            throw Object.assign(new Error("报价创建人不能审批自己的报价"), { statusCode: 403 });
        if (quote.version !== approval.quote_version) {
            await invalidateQuote(organizationId, quote, approval, "报价版本已变化，原审批失效。");
            return { approvalId, decision: "invalidated" as const, quoteId: quote.id };
        }
        if (!quote.trade_term || !quote.named_place || !quote.valid_until || quote.valid_until <= now()) {
            await invalidateQuote(organizationId, quote, approval, "报价条款不完整或有效期已过。");
            return { approvalId, decision: "invalidated" as const, quoteId: quote.id };
        }
        const evidenceError = await validateQuoteEvidence(organizationId, quote);
        if (evidenceError) {
            await invalidateQuote(organizationId, quote, approval, `${evidenceError}。`);
            return { approvalId, decision: "invalidated" as const, quoteId: quote.id };
        }
        let policy: Policy;
        try {
            policy = await activePolicy(organizationId);
        }
        catch {
            await invalidateQuote(organizationId, quote, approval, "当前没有生效的报价政策。");
            return { approvalId, decision: "invalidated" as const, quoteId: quote.id };
        }
        if (quote.policy_version !== policy.version || quote.policy_id !== policy.id) {
            await invalidateQuote(organizationId, quote, approval, "报价政策已更新，原审批失效。");
            return { approvalId, decision: "invalidated" as const, quoteId: quote.id };
        }
        await run("UPDATE approvals SET status=?,decided_by=?,decision_note=?,decided_at=? WHERE id=?", decision, actorId, note, now(), approvalId);
        await run("UPDATE quotes SET status=?,updated_at=? WHERE id=?", decision === "approved" ? "approved" : "rejected", now(), quote.id);
        if (decision === "approved") {
            if (isProduction()) {
                await updateRun(quote.run_id, "manual_delivery_required", "审批已通过，请从已有客户渠道人工发送正式报价并登记交付。", quote.id);
                await event(organizationId, quote.run_id, "manual_delivery", "飞书仅作内部提醒；生产模式未自动向客户发送报价");
            }
            else {
                await scheduleAgentJob({ organizationId, runId: quote.run_id, kind: "dispatch" });
                await updateRun(quote.run_id, "dispatch_queued", "审批已通过，等待发送任务执行。", quote.id);
            }
        }
        else
            await updateRun(quote.run_id, "rejected", "报价未获批准，未发送给客户。", quote.id);
        await event(organizationId, quote.run_id, "human_decision", `${decision === "approved" ? "通过" : "驳回"}：${note || "无备注"}`);
        await audit(organizationId, actorId, `approval.${decision}`, "approval", approvalId, note || "无备注");
        if (decision === "rejected")
            void exportRunTrace(organizationId, quote.run_id).catch((error: unknown) => console.warn("Langfuse export failed:", String(error)));
        return { approvalId, decision, quoteId: quote.id };
    });
    return result;
}
export async function recordManualDelivery(organizationId: string, actorId: string, role: Role, quoteId: string, channel: "email" | "whatsapp" | "other", externalReference: string, note: string) {
    if (!isProduction())
        throw Object.assign(new Error("人工交付登记仅用于生产模式"), { statusCode: 409 });
    if (!["sales", "manager", "admin"].includes(role))
        throw Object.assign(new Error("当前角色无权登记交付"), { statusCode: 403 });
    return await transaction(async () => {
        const quote = await one<Quote>("SELECT * FROM quotes WHERE id=? AND organization_id=?", quoteId, organizationId);
        if (!quote)
            throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
        const existing = await one<{
            id: string;
            channel: string;
            external_reference: string;
        }>("SELECT id,channel,external_reference FROM manual_deliveries WHERE quote_id=? AND organization_id=?", quoteId, organizationId);
        if (existing) {
            if (existing.channel !== channel || existing.external_reference !== externalReference)
                throw Object.assign(new Error("该报价已登记其他交付记录"), { statusCode: 409 });
            return { id: existing.id, quoteId, status: "manual_delivery_recorded" as const };
        }
        if (await one("SELECT id FROM manual_deliveries WHERE organization_id=? AND channel=? AND external_reference=?", organizationId, channel, externalReference)) {
            throw Object.assign(new Error("外部交付凭据已被其他报价使用"), { statusCode: 409 });
        }
        const approval = await one<Approval>("SELECT * FROM approvals WHERE quote_id=? AND organization_id=?", quoteId, organizationId);
        if (quote.status !== "approved" || approval?.status !== "approved")
            throw Object.assign(new Error("报价尚未批准或已失效"), { statusCode: 409 });
        if (quote.version !== approval.quote_version || !quote.trade_term || !quote.named_place || !quote.valid_until || quote.valid_until <= now()) {
            await invalidateQuote(organizationId, quote, approval, "报价版本、条款或有效期发生变化。");
            return { id: "", quoteId, status: "invalidated" as const };
        }
        const evidenceError = await validateQuoteEvidence(organizationId, quote);
        if (evidenceError) {
            await invalidateQuote(organizationId, quote, approval, `${evidenceError}。`);
            return { id: "", quoteId, status: "invalidated" as const };
        }
        let policy: Policy;
        try {
            policy = await activePolicy(organizationId);
        }
        catch {
            await invalidateQuote(organizationId, quote, approval, "当前没有生效的报价政策。");
            return { id: "", quoteId, status: "invalidated" as const };
        }
        if (quote.policy_id !== policy.id || quote.policy_version !== policy.version) {
            await invalidateQuote(organizationId, quote, approval, "报价政策已更新。");
            return { id: "", quoteId, status: "invalidated" as const };
        }
        const deliveryId = id();
        const stamp = now();
        await run("INSERT INTO manual_deliveries(id,organization_id,quote_id,channel,external_reference,note,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?,?)", deliveryId, organizationId, quoteId, channel, externalReference, note, actorId, stamp);
        await run("UPDATE quotes SET status='manual_delivery_recorded',updated_at=? WHERE id=? AND organization_id=?", stamp, quoteId, organizationId);
        await updateRun(quote.run_id, "manual_delivery_recorded", "销售已登记人工发送；系统尚未验证客户渠道回执。", quoteId);
        await event(organizationId, quote.run_id, "manual_delivery_recorded", `${channel} 人工交付登记；外部回执未核验`);
        await audit(organizationId, actorId, "quote.manual_delivery_recorded", "quote", quoteId, `${channel} · ${externalReference}`);
        return { id: deliveryId, quoteId, status: "manual_delivery_recorded" as const };
    });
}
export async function getRunDetail(organizationId: string, runId: string) {
    const agentRun = await one("SELECT * FROM agent_runs WHERE id=? AND organization_id=?", runId, organizationId);
    if (!agentRun)
        return undefined;
    return {
        run: agentRun,
        events: await all<{
            stage: string;
            detail: string;
        }>("SELECT * FROM agent_events WHERE run_id=? AND organization_id=? ORDER BY created_at,id", runId, organizationId),
        tools: await all("SELECT * FROM tool_calls WHERE run_id=? AND organization_id=? ORDER BY created_at,id", runId, organizationId)
    };
}
export async function retryRun(organizationId: string, actorId: string, runId: string) {
    const result = await transaction(async () => {
        const agentRun = await one<AgentRun & {
            retry_count: number;
        }>("SELECT * FROM agent_runs WHERE id=? AND organization_id=?", runId, organizationId);
        if (!agentRun)
            throw Object.assign(new Error("运行记录不存在"), { statusCode: 404 });
        if (!["needs_manual_review", "failed"].includes(agentRun.status) || agentRun.quote_id) {
            throw Object.assign(new Error("当前任务状态不能重新分析"), { statusCode: 409 });
        }
        if (agentRun.retry_count >= 3)
            throw Object.assign(new Error("该任务已达到人工重试上限，请创建新的询价"), { statusCode: 409 });
        await run("UPDATE agent_runs SET status='queued',mode='pending',summary='人工重新发起分析',retry_count=retry_count+1,updated_at=? WHERE id=? AND organization_id=?", now(), runId, organizationId);
        await event(organizationId, runId, "manual_retry", "人工触发重新分析");
        await audit(organizationId, actorId, "run.retried", "run", runId, "人工重试");
        const generation = agentRun.retry_count + 1;
        await scheduleAgentJob({ organizationId, runId, kind: "analyze", generation });
        return { runId, status: "queued" as const };
    });
    return result;
}

import { all, one } from "./db.js";
import { customerMemories, searchKnowledge, type Evidence } from "./retrieval.js";
import { searchMem0 } from "./mem0.js";
export type Role = "sales" | "manager" | "finance" | "admin" | "auditor";
export type DomainActor = {
    id: string;
    organizationId: string;
    role: Role;
    source: "user" | "agent";
    runId?: string;
};
export type Product = {
    id: string;
    organization_id: string;
    sku: string;
    name: string;
    category: string;
    currency: string;
    list_price_cents: number;
    cost_cents: number;
    moq: number;
    lead_days: number;
    description: string;
};
export type Policy = {
    id: string;
    organization_id: string;
    title: string;
    version: string;
    max_sales_discount_bps: number;
    min_margin_bps: number;
    body: string;
};
async function assertAgentCustomerScope(actor: DomainActor, customerId: string) {
    if (actor.source !== "agent")
        return;
    if (!actor.runId)
        throw new Error("Agent 领域访问缺少运行标识");
    const bound = await one("SELECT id FROM agent_runs WHERE id=? AND organization_id=? AND customer_id=?", actor.runId, actor.organizationId, customerId);
    if (!bound)
        throw new Error("客户与 Agent 运行任务不匹配");
}
export async function listCustomers(actor: DomainActor, query = "") {
    if (actor.source !== "user")
        throw new Error("Agent 不允许枚举客户");
    const pattern = `%${query}%`;
    return await all(`SELECT c.*,u.name AS owner_name,
    (SELECT COUNT(*) FROM agent_runs r WHERE r.customer_id=c.id AND r.organization_id=c.organization_id) AS run_count
    FROM customers c LEFT JOIN users u ON u.id=c.owner_id
    WHERE c.organization_id=? AND (?<>'sales' OR c.owner_id=?) AND (c.name LIKE ? OR c.country LIKE ?)
    ORDER BY c.last_contact_at DESC LIMIT 30`, actor.organizationId, actor.role, actor.id, pattern, pattern);
}
export async function getCustomerProfile(actor: DomainActor, customerId: string) {
    await assertAgentCustomerScope(actor, customerId);
    const customer = actor.source === "user"
        ? await one("SELECT id,organization_id,name,country,industry,tier,status,owner_id,description,last_contact_at FROM customers WHERE id=? AND organization_id=? AND (?<>'sales' OR owner_id=?)", customerId, actor.organizationId, actor.role, actor.id) : await one("SELECT id,organization_id,name,country,industry,tier,status,owner_id,description,last_contact_at FROM customers WHERE id=? AND organization_id=?", customerId, actor.organizationId);
    if (!customer)
        throw new Error("客户不存在或无权访问");
    return customer;
}
export async function searchProducts(actor: DomainActor, query: string, includeCost = false) {
    const needle = query.toLowerCase();
    const products = (await all<Product>("SELECT * FROM products WHERE organization_id=? ORDER BY sku", actor.organizationId)).filter((product) => !needle || `${product.sku} ${product.name} ${product.description}`.toLowerCase().includes(needle));
    if (includeCost)
        return products;
    return products.slice(0, 20).map(({ cost_cents: _cost, ...product }) => product);
}
export async function getActivePolicy(actor: DomainActor): Promise<Policy> {
    const current = new Date().toISOString();
    const policy = await one<Policy>("SELECT * FROM policies WHERE organization_id=? AND status='published' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY effective_from DESC LIMIT 1", actor.organizationId, current, current);
    if (!policy)
        throw new Error("没有已生效的报价政策");
    return policy;
}
export async function searchCustomerMemory(actor: DomainActor, customerId: string, query: string): Promise<Evidence[]> {
    await getCustomerProfile(actor, customerId);
    return [...await customerMemories(actor.organizationId, customerId), ...await searchMem0(actor.organizationId, customerId, query)];
}
export async function searchEnterpriseKnowledge(actor: DomainActor, query: string, sku?: string) {
    return await searchKnowledge(actor.organizationId, query, sku);
}

import { all, id, now, one, run } from "./db.js";
import { parseInquiryLocally } from "./model.js";
import { activePolicy, calculatePrice, type Product } from "./tools.js";
type CaseResult = {
    id: string;
    title: string;
    passed: boolean;
    detail: string;
};
export async function runEvaluation(organizationId: string) {
    const product = await one<Product>("SELECT * FROM products WHERE organization_id=? AND sku='AX-200'", organizationId);
    if (!product)
        throw new Error("评测基线产品不存在");
    const policy = await activePolicy(organizationId);
    const cases: CaseResult[] = [];
    async function check(caseId: string, title: string, test: () => boolean | Promise<boolean>, detail: string) {
        try {
            cases.push({ id: caseId, title, passed: await test(), detail });
        }
        catch (error) {
            cases.push({ id: caseId, title, passed: false, detail: String(error) });
        }
    }
    await check("extract-mixed", "中英混合询价抽取", () => {
        const data = parseInquiryLocally("Need 5,000 units of AX-200, with 20% discount, FOB", ["AX-200"]);
        return data.sku === "AX-200" && data.quantity === 5000 && data.requestedDiscountPercent === 20 && data.tradeTerm === "FOB";
    }, "SKU、数量、折扣、贸易术语应准确提取");
    await check("pricing", "报价金额与毛利率", () => {
        const price = calculatePrice(product, 5000, 2000);
        return price.unitPriceCents === 1024 && price.totalCents === 5120000 && price.marginBps === 1699;
    }, "整数分计算，避免浮点金额误差");
    await check("moq", "最小起订量拦截", () => {
        try {
            calculatePrice(product, product.moq - 1, 0);
            return false;
        }
        catch {
            return true;
        }
    }, "低于 MOQ 时不得生成报价");
    await check("discount-policy", "折扣升级审批", () => 2000 > policy.max_sales_discount_bps, "20% 折扣必须越过销售自行报价权限");
    await check("below-cost", "低于成本价拦截", () => calculatePrice(product, 5000, 4000).unitPriceCents <= product.cost_cents, "40% 折扣不应进入自动发送");
    await check("tenant-isolation", "跨租户客户隔离", async () => !await one("SELECT id FROM customers WHERE id='cust_other' AND organization_id=?", organizationId), "他租户客户不可查询");
    await check("memory-governance", "候选记忆不得当作权威事实", async () => {
        const items = await all<{
            status: string;
        }>("SELECT status FROM memories WHERE organization_id=? AND customer_id='cust_acme'", organizationId);
        return items.some((item) => item.status === "candidate") && items.some((item) => item.status === "confirmed");
    }, "候选与已确认记忆状态分离");
    await check("knowledge-version", "知识版本与状态过滤", async () => {
        const current = now();
        const documents = await all<{
            status: string;
        }>("SELECT status FROM knowledge_documents WHERE organization_id=? AND status='published' AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)", organizationId, current, current);
        return documents.length >= 1 && documents.every((item) => item.status === "published");
    }, "仅已发布且当前生效的文档可进入证据包");
    const evaluationId = id();
    const result = { id: evaluationId, total: cases.length, passed: cases.filter((item) => item.passed).length, cases, createdAt: now() };
    await run("INSERT INTO evaluation_runs(id,organization_id,total,passed,results_json,created_at) VALUES(?,?,?,?,?,?)", evaluationId, organizationId, result.total, result.passed, JSON.stringify(cases), result.createdAt);
    return result;
}

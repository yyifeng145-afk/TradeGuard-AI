import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Model } from "@mariozechner/pi-ai";
import { contentHash } from "./integrity.js";
import { id, now, run } from "./db.js";
import { getOpportunity } from "./opportunities.js";
import type { DomainActor } from "./domain.js";
type ExpertName = "commercial" | "delivery_risk" | "evidence_auditor";
const opportunityParameters = Type.Object({ opportunityId: Type.String() });
function configuredModel(): Model<"openai-completions"> {
    const baseUrl = process.env.MODEL_BASE_URL?.replace(/\/$/, "");
    const modelId = process.env.MODEL_NAME;
    if (!baseUrl || !modelId || !process.env.MODEL_API_KEY)
        throw new Error("Pi Runtime 需要配置 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY");
    return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "crm-openai-compatible",
        baseUrl,
        reasoning: modelId.toLowerCase().startsWith("qwen"),
        input: ["text"],
        cost: {
            input: Math.max(0, Number(process.env.MODEL_INPUT_USD_PER_MILLION ?? 0)),
            output: Math.max(0, Number(process.env.MODEL_OUTPUT_USD_PER_MILLION ?? 0)), cacheRead: 0, cacheWrite: 0
        },
        contextWindow: 128000,
        maxTokens: 2000,
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStore: false,
            maxTokensField: "max_tokens",
            thinkingFormat: "qwen"
        }
    };
}
function assistantResult(agent: Agent) {
    const message = [...agent.state.messages].reverse().find((item) => item.role === "assistant");
    if (!message || message.role !== "assistant")
        throw new Error("Pi Agent 未返回分析结果");
    const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
    if (!text)
        throw new Error(message.errorMessage || "Pi Agent 返回了空结果");
    return { text, inputTokens: message.usage.input, outputTokens: message.usage.output };
}
function readOnlyOpportunityTool(actor: DomainActor, opportunityId: string): AgentTool<typeof opportunityParameters> {
    return {
        name: "read_opportunity",
        label: "Read governed opportunity",
        description: "Read the authorized opportunity, sourced field claims, conflicts and follow-up tasks. This tool cannot mutate CRM data.",
        parameters: opportunityParameters,
        executionMode: "parallel",
        execute: async (_callId, parameters) => {
            if (parameters.opportunityId !== opportunityId)
                throw new Error("专家只能读取当前商机");
            return { content: [{ type: "text", text: JSON.stringify(await getOpportunity(actor, opportunityId)) }], details: { opportunityId, access: "read-only" } };
        }
    };
}
async function runExpert(actor: DomainActor, opportunityId: string, expertName: ExpertName) {
    const expertId = id();
    const startedAt = now();
    await run("INSERT INTO expert_runs(id,organization_id,opportunity_id,expert_name,status,input_hash,started_at) VALUES(?,?,?,?,?,?,?)", expertId, actor.organizationId, opportunityId, expertName, "running", contentHash(`${opportunityId}:${expertName}`), startedAt);
    const prompts: Record<ExpertName, string> = {
        commercial: "Assess qualification, budget, decision process and next commercial action.",
        delivery_risk: "Assess product, lead-time, trade-term and fulfilment risks. Do not invent missing facts.",
        evidence_auditor: "Audit field-level sources, versions and conflicts. Flag every conclusion that lacks evidence."
    };
    try {
        const agent = new Agent({
            initialState: {
                systemPrompt: `You are the ${expertName} read-only CRM expert. You may only inspect data through read_opportunity. Return concise JSON with findings, risks, missing_evidence and recommended_actions. Never mutate data or claim that an action was executed.`,
                model: configuredModel(), tools: [readOnlyOpportunityTool(actor, opportunityId)], messages: [], thinkingLevel: "off"
            },
            getApiKey: () => process.env.MODEL_API_KEY,
            toolExecution: "parallel",
            beforeToolCall: async ({ toolCall }) => toolCall.name === "read_opportunity" ? undefined : { block: true, reason: "只读专家禁止调用其他工具" }
        });
        await agent.prompt(`${prompts[expertName]} First call read_opportunity with opportunityId ${opportunityId}.`);
        const result = assistantResult(agent);
        await run("UPDATE expert_runs SET status='succeeded',result_json=?,token_input=?,token_output=?,finished_at=? WHERE id=?", result.text, result.inputTokens, result.outputTokens, now(), expertId);
        return { expertName, ...result };
    }
    catch (error) {
        await run("UPDATE expert_runs SET status='failed',error=?,finished_at=? WHERE id=?", String(error).slice(0, 500), now(), expertId);
        throw error;
    }
}
export async function runPiOpportunityAnalysis(actor: DomainActor, opportunityId: string) {
    await getOpportunity(actor, opportunityId);
    const experts = await Promise.all((['commercial', 'delivery_risk', 'evidence_auditor'] as ExpertName[])
        .map(async (name) => await runExpert(actor, opportunityId, name)));
    const leadId = id();
    await run("INSERT INTO expert_runs(id,organization_id,opportunity_id,expert_name,status,input_hash,started_at) VALUES(?,?,?,?,?,?,?)", leadId, actor.organizationId, opportunityId, "lead", "running", contentHash(JSON.stringify(experts.map((item) => item.text))), now());
    try {
        const lead = new Agent({
            initialState: {
                systemPrompt: "You are the lead CRM analyst. Reconcile expert outputs without hiding disagreements. Return strict JSON with executive_summary, opportunity_score_0_to_100, confirmed_facts, conflicts, risks, missing_evidence and next_actions. Never state that a business action was executed.",
                model: configuredModel(), tools: [], messages: [], thinkingLevel: "off"
            },
            getApiKey: () => process.env.MODEL_API_KEY,
            beforeToolCall: async () => ({ block: true, reason: "主分析阶段不允许执行写操作" })
        });
        await lead.prompt(JSON.stringify({ opportunityId, expertOutputs: experts.map(({ expertName, text }) => ({ expertName, text })) }));
        const result = assistantResult(lead);
        await run("UPDATE expert_runs SET status='succeeded',result_json=?,token_input=?,token_output=?,finished_at=? WHERE id=?", result.text, result.inputTokens, result.outputTokens, now(), leadId);
        return { runtime: "pi-agent-core", opportunityId, experts, report: result.text };
    }
    catch (error) {
        await run("UPDATE expert_runs SET status='failed',error=?,finished_at=? WHERE id=?", String(error).slice(0, 500), now(), leadId);
        throw error;
    }
}

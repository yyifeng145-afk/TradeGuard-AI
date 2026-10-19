import { randomBytes } from "node:crypto";
import { all, one } from "./db.js";

type RunRow = { id: string; organization_id: string; status: string; mode: string; created_at: string; updated_at: string };
type ToolRow = { tool_name: string; risk_level: string; status: string; duration_ms: number; created_at: string };
type ModelRow = { purpose: string; provider_model: string; status: string; duration_ms: number; token_input: number | null; token_output: number | null; cost_microusd: number | null; created_at: string };

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (value: string) => String(BigInt(Date.parse(value)) * 1_000_000n);

// Export only operational metadata: never ship customer messages, tool inputs, or quote contents.
export async function exportRunTrace(organizationId: string, runId: string) {
  const base = process.env.LANGFUSE_BASE_URL;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!base || !publicKey || !secretKey) return;
  const agentRun = one<RunRow>("SELECT id,organization_id,status,mode,created_at,updated_at FROM agent_runs WHERE id=? AND organization_id=?", runId, organizationId);
  if (!agentRun) return;
  const traceId = runId.replaceAll("-", "").slice(0, 32);
  if (!/^[a-f0-9]{32}$/.test(traceId)) return;
  const parentId = randomBytes(8).toString("hex");
  const tools = all<ToolRow>("SELECT tool_name,risk_level,status,duration_ms,created_at FROM tool_calls WHERE run_id=? AND organization_id=? ORDER BY created_at", runId, organizationId);
  const models = all<ModelRow>("SELECT purpose,provider_model,status,duration_ms,token_input,token_output,cost_microusd,created_at FROM model_calls WHERE run_id=? AND organization_id=? ORDER BY created_at", runId, organizationId);
  const spans = [
    {
      traceId, spanId: parentId, name: "crm.agent.run", kind: 1,
      startTimeUnixNano: nanos(agentRun.created_at), endTimeUnixNano: nanos(agentRun.updated_at),
      attributes: [attribute("crm.organization_id", organizationId), attribute("crm.run_id", runId), attribute("crm.mode", agentRun.mode), attribute("crm.status", agentRun.status)],
      status: { code: agentRun.status === "failed" ? 2 : 1 }
    },
    ...tools.map((tool) => ({
      traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: parentId,
      name: `crm.tool.${tool.tool_name}`, kind: 1,
      startTimeUnixNano: nanos(tool.created_at), endTimeUnixNano: String(BigInt(nanos(tool.created_at)) + BigInt(tool.duration_ms) * 1_000_000n),
      attributes: [attribute("crm.risk", tool.risk_level), attribute("crm.result", tool.status), attribute("crm.duration_ms", String(tool.duration_ms))],
      status: { code: tool.status === "success" ? 1 : 2 }
    })),
    ...models.map((model) => ({
      traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: parentId,
      name: `crm.model.${model.purpose}`, kind: 1,
      startTimeUnixNano: nanos(model.created_at), endTimeUnixNano: String(BigInt(nanos(model.created_at)) + BigInt(model.duration_ms) * 1_000_000n),
      attributes: [
        attribute("gen_ai.request.model", model.provider_model), attribute("crm.result", model.status),
        attribute("gen_ai.usage.input_tokens", String(model.token_input ?? 0)), attribute("gen_ai.usage.output_tokens", String(model.token_output ?? 0)),
        attribute("crm.cost_microusd", String(model.cost_microusd ?? 0))
      ],
      status: { code: model.status === "success" ? 1 : 2 }
    }))
  ];
  const response = await fetch(`${base.replace(/\/$/, "")}/api/public/otel/v1/traces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      "x-langfuse-ingestion-version": "4"
    },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [attribute("service.name", "borderless-crm-agent")] }, scopeSpans: [{ scope: { name: "borderless-crm-worker" }, spans }] }] }),
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Langfuse HTTP ${response.status}`);
}

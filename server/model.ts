import { z } from "zod";
import { isProduction } from "./config.js";

export const InquirySchema = z.object({
  sku: z.string().nullable(),
  quantity: z.number().int().positive().max(100_000_000).nullable(),
  requestedDiscountPercent: z.number().min(0).max(99).nullable(),
  destination: z.string().nullable(),
  tradeTerm: z.enum(["FOB", "CIF", "EXW"]).nullable(),
  notes: z.string().nullable()
});
export type Inquiry = z.infer<typeof InquirySchema>;

export function parseInquiryLocally(text: string, skus: string[]): Inquiry {
  const normalized = text.toUpperCase();
  const sku = skus.find((value) => normalized.includes(value.toUpperCase())) ?? null;
  const withoutSku = skus.reduce((value, item) => value.replaceAll(item, " "), text);
  const quantityMatch = withoutSku.match(/(\d[\d,]*)\s*(?:件|个|台|PCS|UNITS?|PIECES?)/i);
  const contextualQuantity = withoutSku.match(/(?:QUOTE|NEED|WANT|订购|采购|数量)\s*(\d[\d,]*)/i);
  const discountMatch = text.match(/(?:DISCOUNT|折扣|优惠|OFF)?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  const termMatch = text.match(/\b(FOB|CIF|EXW)\b/i);
  const namedPlaceMatch = text.match(/\b(?:FOB|EXW)\s+([\p{L}][\p{L}\s-]{1,50})(?=[,.;!?。；，！？]|$)/iu);
  const destinationMatch = text.match(/(?:SHIP TO|DESTINATION|目的港|运往)\s*([A-Za-z\u4e00-\u9fa5\s-]{2,30})/i);
  return {
    sku,
    quantity: quantityMatch ? Number(quantityMatch[1].replaceAll(",", "")) : contextualQuantity ? Number(contextualQuantity[1].replaceAll(",", "")) : null,
    requestedDiscountPercent: discountMatch ? Number(discountMatch[1]) : null,
    destination: namedPlaceMatch?.[1]?.trim() ?? destinationMatch?.[1]?.trim() ?? null,
    tradeTerm: termMatch ? termMatch[1].toUpperCase() as Inquiry["tradeTerm"] : null,
    notes: null
  };
}

const manualInquiry: Inquiry = {
  sku: null, quantity: null, requestedDiscountPercent: null,
  destination: null, tradeTerm: null, notes: null
};

export type ModelUsage = { inputTokens: number; outputTokens: number; durationMs: number; model: string; costMicrousd: number };

export async function extractInquiry(text: string, skus: string[]): Promise<{ inquiry: Inquiry; mode: "model" | "demo" | "manual"; warning?: string; usage?: ModelUsage }> {
  const base = process.env.MODEL_BASE_URL;
  const key = process.env.MODEL_API_KEY;
  const model = process.env.MODEL_NAME;
  if (!base || !key || !model) return isProduction()
    ? { inquiry: { ...manualInquiry }, mode: "manual", warning: "模型服务未配置" }
    : { inquiry: parseInquiryLocally(text, skus), mode: "demo" };
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.MODEL_TIMEOUT_MS ?? 30_000);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(Math.max(configuredTimeout, 5_000), 120_000) : 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        ...(model.toLowerCase().startsWith("qwen") ? { enable_thinking: false } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `Extract only explicit purchase inquiry facts. Return JSON with sku, quantity, requestedDiscountPercent, destination, tradeTerm, notes. Use null if absent. Valid SKUs: ${skus.join(", ")}. Do not invent values.` },
          { role: "user", content: text }
        ]
      })
    });
    if (!response.ok) throw new Error(`model HTTP ${response.status}`);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("model response was empty");
    const inquiry = InquirySchema.parse(JSON.parse(content));
    const observed = parseInquiryLocally(text, skus);
    if (inquiry.sku && !skus.includes(inquiry.sku)) inquiry.sku = null;
    // A model may structure the text, but it cannot introduce numbers or trade terms absent from the message.
    if (inquiry.sku && !text.toUpperCase().includes(inquiry.sku.toUpperCase())) inquiry.sku = null;
    if (inquiry.quantity && !text.replaceAll(",", "").includes(String(inquiry.quantity))) inquiry.quantity = null;
    if (inquiry.requestedDiscountPercent != null && inquiry.requestedDiscountPercent !== observed.requestedDiscountPercent) inquiry.requestedDiscountPercent = null;
    if (inquiry.tradeTerm && !text.toUpperCase().includes(inquiry.tradeTerm)) inquiry.tradeTerm = null;
    if (inquiry.destination && !text.toLowerCase().includes(inquiry.destination.toLowerCase())) inquiry.destination = null;
    if (inquiry.tradeTerm && !inquiry.destination) inquiry.destination = observed.destination;
    const inputTokens = payload.usage?.prompt_tokens ?? payload.usage?.input_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? payload.usage?.output_tokens ?? 0;
    const inputPrice = Math.max(0, Number(process.env.MODEL_INPUT_USD_PER_MILLION ?? 0));
    const outputPrice = Math.max(0, Number(process.env.MODEL_OUTPUT_USD_PER_MILLION ?? 0));
    const costMicrousd = Math.round(inputTokens * inputPrice + outputTokens * outputPrice);
    return { inquiry, mode: "model", usage: { inputTokens, outputTokens, durationMs: Math.round(performance.now() - startedAt), model, costMicrousd } };
  } catch (error) {
    if (isProduction()) return { inquiry: { ...manualInquiry }, mode: "manual", warning: String(error) };
    return { inquiry: parseInquiryLocally(text, skus), mode: "demo", warning: String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

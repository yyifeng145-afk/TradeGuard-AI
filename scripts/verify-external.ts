import { createHmac } from "node:crypto";
import { loadRuntimeSecrets } from "../server/config.js";
import { extractInquiry } from "../server/model.js";

process.env.MODEL_API_KEY_FILE ??= process.env.MODEL_API_KEY_SECRET_FILE;
process.env.FEISHU_BOT_WEBHOOK_FILE ??= process.env.FEISHU_BOT_WEBHOOK_SECRET_FILE;

loadRuntimeSecrets();

function feishuSignature(timestamp: string, secret: string) {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

async function verifyModel() {
  if (!process.env.MODEL_BASE_URL || !process.env.MODEL_API_KEY || !process.env.MODEL_NAME) throw new Error("模型配置不完整");
  const started = Date.now();
  const result = await extractInquiry("Please quote 1,500 units of SAFE-001, FOB Shanghai.", ["SAFE-001"]);
  const elapsedMs = Date.now() - started;
  if (result.mode !== "model") throw new Error(`真实模型验证失败：${result.warning ?? result.mode}`);
  if (result.inquiry.sku !== "SAFE-001" || result.inquiry.quantity !== 1500 || result.inquiry.tradeTerm !== "FOB" || result.inquiry.destination !== "Shanghai") {
    throw new Error(`模型结构化结果不符合预期：${JSON.stringify(result.inquiry)}`);
  }
  const maxMs = Number(process.env.MODEL_VERIFY_MAX_MS ?? 20_000);
  if (elapsedMs > maxMs) throw new Error(`模型耗时 ${elapsedMs}ms，超过验收阈值 ${maxMs}ms`);
  const realBaseUrl = process.env.MODEL_BASE_URL;
  const realAppEnv = process.env.APP_ENV;
  process.env.MODEL_BASE_URL = "http://127.0.0.1:9";
  process.env.APP_ENV = "production";
  const failureStarted = Date.now();
  const degraded = await extractInquiry("Synthetic failure test", ["SAFE-001"]);
  process.env.MODEL_BASE_URL = realBaseUrl;
  if (realAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = realAppEnv;
  if (degraded.mode !== "manual") throw new Error("模型故障未按预期降级为人工复核模式");
  return { ok: true, elapsedMs, model: process.env.MODEL_NAME, failureDegradationVerified: true, failureDetectionMs: Date.now() - failureStarted };
}

async function sendFeishu(sequence: number) {
  const webhook = process.env.FEISHU_BOT_WEBHOOK;
  const secret = process.env.FEISHU_BOT_SECRET;
  if (!webhook || !secret) throw new Error("飞书机器人配置不完整");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8_000), body: JSON.stringify({
    timestamp, sign: feishuSignature(timestamp, secret), msg_type: "text",
    content: { text: `[CRM 上线联调] 合成测试消息 ${sequence}，不含客户数据。请由验收人员确认是否收到。` }
  }) });
  const body = await response.json() as { code?: number; msg?: string };
  return { sequence, httpStatus: response.status, code: body.code, message: body.msg ?? "" };
}

async function verifyFeishu() {
  const count = process.env.FEISHU_RATE_TEST_CONFIRM === "YES"
    ? Math.min(10, Math.max(1, Number(process.env.FEISHU_VERIFY_COUNT ?? 6))) : 1;
  const results = [];
  for (let index = 1; index <= count; index++) results.push(await sendFeishu(index));
  if (!results[0] || results[0].httpStatus < 200 || results[0].httpStatus >= 300 || results[0].code !== 0) {
    throw new Error(`飞书真实发送失败：${JSON.stringify(results[0])}`);
  }
  const accepted = results.filter((item) => item.httpStatus >= 200 && item.httpStatus < 300 && item.code === 0).length;
  const rejected = results.length - accepted;
  return { ok: true, rateLimitTestExecuted: count > 1, accepted, rejected, results };
}

const report = { checkedAt: new Date().toISOString(), syntheticDataOnly: true, model: await verifyModel(), feishu: await verifyFeishu() };
console.log(JSON.stringify(report, null, 2));

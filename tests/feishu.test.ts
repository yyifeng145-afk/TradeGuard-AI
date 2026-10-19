import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.APP_ENV = "test";
process.env.CRM_DB_PATH = ":memory:";
process.env.FEISHU_BOT_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-only";
process.env.FEISHU_BOT_SECRET = "test-secret";

const { initDatabase, one } = await import("../server/db.js");
const { feishuSignature, queueInternalNotification, sendInternalNotificationOnce } = await import("../server/feishu.js");
initDatabase();

test("Feishu internal reminder is signed, deduplicated and contains no customer data", async () => {
  const timestamp = "1234567890";
  assert.equal(feishuSignature(timestamp, "test-secret"), createHmac("sha256", `${timestamp}\ntest-secret`).update("").digest("base64"));
  queueInternalNotification("org_northstar", "approval:sample", "approval_pending", "approval-id");
  queueInternalNotification("org_northstar", "approval:sample", "approval_pending", "approval-id");
  assert.equal(one<{ count: number }>("SELECT COUNT(*) AS count FROM internal_notifications")?.count, 1);
  const originalFetch = globalThis.fetch;
  let payload: { sign?: string; content?: { text: string } } = {};
  globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
  };
  try {
    assert.equal(await sendInternalNotificationOnce(), true);
    assert.equal(await sendInternalNotificationOnce(), false);
    assert.ok(payload.sign);
    assert.match(payload.content?.text ?? "", /approval-id/);
    assert.doesNotMatch(payload.content?.text ?? "", /客户|价格|金额|报价内容/);
    assert.equal(one<{ status: string }>("SELECT status FROM internal_notifications WHERE dedupe_key='approval:sample'")?.status, "sent");
  } finally { globalThis.fetch = originalFetch; }
});

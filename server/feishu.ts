import { createHmac } from "node:crypto";
import { id, now, one, run, transaction } from "./db.js";

type Notification = {
  id: string; organization_id: string; kind: string; target_id: string;
  attempt: number; status: string;
};

export function queueInternalNotification(organizationId: string, dedupeKey: string, kind: "approval_pending" | "manual_review" | "job_failed" | "system_alert", targetId: string) {
  if (!process.env.FEISHU_BOT_WEBHOOK) return;
  run("INSERT OR IGNORE INTO internal_notifications(id,organization_id,dedupe_key,kind,target_id,status,available_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
    id(), organizationId, dedupeKey, kind, targetId, now(), now());
}

export function feishuSignature(timestamp: string, secret: string) {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

function notificationText(item: Notification) {
  const action = item.kind === "approval_pending" ? "有报价等待人工审批" : item.kind === "manual_review" ? "有询价需要人工核对" : item.kind === "system_alert" ? "生产监控触发系统告警" : "有 Agent 任务执行失败";
  // Do not copy customer names, messages, prices, or document contents into a group chat.
  return `[CRM 内部待办] ${action}。记录 ID：${item.target_id}。请登录 CRM 工作台查看详情。`;
}

export async function sendInternalNotificationOnce() {
  const webhook = process.env.FEISHU_BOT_WEBHOOK;
  if (!webhook) return false;
  const item = transaction(() => {
    const pending = one<Notification>("SELECT * FROM internal_notifications WHERE status='pending' AND available_at<=? ORDER BY created_at LIMIT 1", now());
    if (!pending) return undefined;
    run("UPDATE internal_notifications SET status='sending',attempt=attempt+1 WHERE id=? AND status='pending'", pending.id);
    return one<Notification>("SELECT * FROM internal_notifications WHERE id=?", pending.id);
  });
  if (!item) return false;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = {
    timestamp,
    ...(process.env.FEISHU_BOT_SECRET ? { sign: feishuSignature(timestamp, process.env.FEISHU_BOT_SECRET) } : {}),
    msg_type: "text", content: { text: notificationText(item) }
  };
  try {
    const response = await fetch(webhook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000)
    });
    const body = await response.json() as { code?: number; msg?: string };
    if (response.ok && body.code === 0) {
      run("UPDATE internal_notifications SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND status='sending'", now(), item.id);
    } else {
      const retry = item.attempt < 3;
      const availableAt = new Date(Date.now() + item.attempt * 60_000).toISOString();
      run("UPDATE internal_notifications SET status=?,available_at=?,last_error=? WHERE id=? AND status='sending'",
        retry ? "pending" : "failed", availableAt, `Feishu ${response.status} code ${body.code ?? "unknown"}`.slice(0, 200), item.id);
    }
  } catch (error) {
    // A timeout may happen after Feishu accepted the message. Do not resend blindly.
    run("UPDATE internal_notifications SET status='uncertain',last_error=? WHERE id=? AND status='sending'",
      String(error).slice(0, 200), item.id);
  }
  return true;
}

export function startInternalNotificationWorker() {
  if (!process.env.FEISHU_BOT_WEBHOOK) return () => {};
  run("UPDATE internal_notifications SET status='uncertain',last_error='进程在发送过程中中断；需要人工核对' WHERE status='sending'");
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { while (await sendInternalNotificationOnce()) { /* drain */ } }
    catch (error) { console.error("Feishu notification worker failed:", error); }
    finally { busy = false; }
  }, 1_000);
  return () => clearInterval(timer);
}

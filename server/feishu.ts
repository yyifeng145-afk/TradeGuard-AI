import { createHmac } from "node:crypto";
import { id, now, one, run, transaction } from "./db.js";
import { scheduleNotificationJob } from "./queue-outbox.js";
type Notification = {
    id: string;
    organization_id: string;
    kind: string;
    target_id: string;
    attempt: number;
    status: string;
};
export async function queueInternalNotification(organizationId: string, dedupeKey: string, kind: "approval_pending" | "manual_review" | "job_failed" | "system_alert", targetId: string) {
    if (!process.env.FEISHU_BOT_WEBHOOK)
        return;
    const notificationId = id();
    await run("INSERT OR IGNORE INTO internal_notifications(id,organization_id,dedupe_key,kind,target_id,status,available_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)", notificationId, organizationId, dedupeKey, kind, targetId, now(), now());
    const notification = await one<{ id: string; status: string }>("SELECT id,status FROM internal_notifications WHERE organization_id=? AND dedupe_key=?", organizationId, dedupeKey);
    if (notification?.status === "pending") {
        await scheduleNotificationJob({ organizationId, notificationId: notification.id });
    }
}
export function feishuSignature(timestamp: string, secret: string) {
    return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}
function notificationText(item: Notification) {
    const action = item.kind === "approval_pending" ? "有报价等待人工审批" : item.kind === "manual_review" ? "有询价需要人工核对" : item.kind === "system_alert" ? "生产监控触发系统告警" : "有 Agent 任务执行失败";
    // Do not copy customer names, messages, prices, or document contents into a group chat.
    return `[CRM 内部待办] ${action}。记录 ID：${item.target_id}。请登录 CRM 工作台查看详情。`;
}
export async function sendInternalNotificationOnce(notificationId?: string) {
    const webhook = process.env.FEISHU_BOT_WEBHOOK;
    if (!webhook)
        return false;
    const item = await transaction(async () => {
        const pending = notificationId
            ? await one<Notification>("SELECT * FROM internal_notifications WHERE id=? AND status='pending'", notificationId)
            : await one<Notification>("SELECT * FROM internal_notifications WHERE status='pending' AND available_at<=? ORDER BY created_at LIMIT 1", now());
        if (!pending)
            return undefined;
        await run("UPDATE internal_notifications SET status='sending',attempt=attempt+1 WHERE id=? AND status='pending'", pending.id);
        return await one<Notification>("SELECT * FROM internal_notifications WHERE id=?", pending.id);
    });
    if (!item)
        return false;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = {
        timestamp,
        ...(process.env.FEISHU_BOT_SECRET ? { sign: feishuSignature(timestamp, process.env.FEISHU_BOT_SECRET) } : {}),
        msg_type: "text", content: { text: notificationText(item) }
    };
    try {
        const response = await fetch(webhook, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
        });
        const body = await response.json() as {
            code?: number;
            msg?: string;
        };
        if (response.ok && body.code === 0) {
            await run("UPDATE internal_notifications SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND status='sending'", now(), item.id);
        }
        else {
            const retry = item.attempt < 3;
            const availableAt = new Date(Date.now() + item.attempt * 60000).toISOString();
            await run("UPDATE internal_notifications SET status=?,available_at=?,last_error=? WHERE id=? AND status='sending'", retry ? "pending" : "failed", availableAt, `Feishu ${response.status} code ${body.code ?? "unknown"}`.slice(0, 200), item.id);
            if (retry) throw Object.assign(new Error(`Feishu ${response.status} code ${body.code ?? "unknown"}`), { retryable: true });
        }
    }
    catch (error) {
        if ((error as { retryable?: boolean }).retryable) throw error;
        // A timeout may happen after Feishu accepted the message. Do not resend blindly.
        await run("UPDATE internal_notifications SET status='uncertain',last_error=? WHERE id=? AND status='sending'", String(error).slice(0, 200), item.id);
    }
    return true;
}

const salesEventDetails: Record<string, string> = {
  pricing: "报价金额已由服务端规则计算，毛利详情仅供审批角色查看。",
  human_decision: "审批已处理；审批备注仅供审批角色查看。",
  retry: "任务执行遇到异常，正在重试。",
  failed: "任务执行失败，请联系管理员排查。",
  model_fallback: "模型抽取未成功，已按当前环境策略处理。"
};

const safeSalesEvents = new Set([
  "received", "context", "extract", "evidence", "clarification", "validation",
  "conflict", "policy_block", "manual_review", "approval", "manual_delivery",
  "manual_delivery_recorded", "delivered", "invalidated", "manual_retry"
]);

export function runDetailForSales(detail: { run: object; events: Array<{ stage: string; detail: string }>; tools: unknown[] }) {
  return {
    ...detail,
    run: { ...detail.run, error: null },
    events: detail.events.map((item) => ({
      ...item,
      detail: safeSalesEvents.has(item.stage) ? item.detail : salesEventDetails[item.stage] ?? "该阶段详情仅供审批角色查看。"
    })),
    tools: []
  };
}

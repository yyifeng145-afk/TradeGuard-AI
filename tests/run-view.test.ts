import assert from "node:assert/strict";
import test from "node:test";
import { runDetailForSales } from "../server/run-view.js";

test("sales run details do not expose margins, approval notes, or internal failures", () => {
  const detail = runDetailForSales({
    run: { id: "run-1", status: "failed", error: "database secret" },
    events: [
      { stage: "pricing", detail: "毛利率 16.9%" },
      { stage: "human_decision", detail: "批准：内部利润信息" },
      { stage: "failed", detail: "MODEL_API_KEY=secret" },
      { stage: "new_internal_stage", detail: "未来新增的敏感详情" },
      { stage: "clarification", detail: "请补充采购数量" }
    ],
    tools: [{ input_json: "private" }]
  });
  assert.equal(detail.run.error, null);
  assert.deepEqual(detail.tools, []);
  assert.equal(detail.events[4].detail, "请补充采购数量");
  assert.doesNotMatch(JSON.stringify(detail), /16\.9|内部利润|secret|敏感详情|private/);
});

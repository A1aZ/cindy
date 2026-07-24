import { describe, expect, it } from 'vitest';

import { computeScheduleRunCostDeltas } from '../runCostLedger.js';

function meta(runId: string, costUsd: number, isEstimate = false): Record<string, unknown> {
  return {
    origin: { kind: 'scheduler', scheduleId: 'schedule-1', runId },
    turnCostUsd: costUsd,
    turnCostIsEstimate: isEstimate,
  };
}

describe('computeScheduleRunCostDeltas', () => {
  it('首次写入真实费用时累计到对应 run', () => {
    expect(computeScheduleRunCostDeltas({}, meta('run-1', 0.42))).toEqual([{
      runId: 'run-1',
      costUsdDelta: 0.42,
      estimatedValueUsdDelta: 0,
    }]);
  });

  it('相同消息重放时不重复累计', () => {
    const current = meta('run-1', 0.42);
    expect(computeScheduleRunCostDeltas(current, { ...current })).toEqual([]);
  });

  it('估算值转为真实费用时在两栏之间搬移', () => {
    expect(computeScheduleRunCostDeltas(meta('run-1', 0.42, true), meta('run-1', 0.4))).toEqual([{
      runId: 'run-1',
      costUsdDelta: 0.4,
      estimatedValueUsdDelta: -0.42,
    }]);
  });

  it('归因 runId 修正时从旧 run 扣除并写入新 run', () => {
    expect(computeScheduleRunCostDeltas(meta('run-old', 0.42), meta('run-new', 0.42))).toEqual([
      { runId: 'run-old', costUsdDelta: -0.42, estimatedValueUsdDelta: 0 },
      { runId: 'run-new', costUsdDelta: 0.42, estimatedValueUsdDelta: 0 },
    ]);
  });
});

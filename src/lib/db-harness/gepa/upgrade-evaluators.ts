import type {
  DBHarnessQueryMetricRecord,
  DBHarnessSemanticUpgradeEvaluation,
  DBHarnessUpgradeEvaluation,
} from '../core/types';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
}

export function evaluateWorkspaceUpgradeMetrics(metrics: DBHarnessQueryMetricRecord[]): DBHarnessUpgradeEvaluation {
  if (metrics.length === 0) {
    return {
      score: 0.32,
      baselineScore: 0.32,
      sqlSuccessRate: 0,
      emptyRate: 0,
      correctiveRate: 0,
      avgLatencyMs: 0,
      avgValidationScore: 0,
      notes: ['当前 workspace 暂无可用于评估的历史指标。'],
    };
  }

  const successRate = metrics.filter((item) => item.outcome === 'success').length / metrics.length;
  const emptyRate = metrics.filter((item) => item.outcome === 'empty').length / metrics.length;
  const correctiveRate = metrics.filter((item) => item.feedbackLabel === 'corrective').length / metrics.length;
  const avgLatencyMs = metrics.reduce((sum, item) => sum + (item.agentTelemetry.query?.latencyMs || 0), 0) / metrics.length;
  const avgValidationScore = metrics.reduce((sum, item) => sum + (item.validationScore || 0.5), 0) / metrics.length;
  const baselineScore = clamp01(metrics.reduce((sum, item) => sum + item.confidence, 0) / metrics.length);
  const score = clamp01(
    baselineScore * 0.45
    + successRate * 0.35
    + avgValidationScore * 0.22
    - emptyRate * 0.16
    - correctiveRate * 0.12
  );

  return {
    score,
    baselineScore,
    sqlSuccessRate: Number(successRate.toFixed(4)),
    emptyRate: Number(emptyRate.toFixed(4)),
    correctiveRate: Number(correctiveRate.toFixed(4)),
    avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
    avgValidationScore: Number(avgValidationScore.toFixed(4)),
    notes: [
      `样本量: ${metrics.length}`,
      `成功率: ${(successRate * 100).toFixed(1)}%`,
      `纠错率: ${(correctiveRate * 100).toFixed(1)}%`,
    ],
  };
}

export function evaluateSemanticUpgradeMetrics(input: {
  metrics: DBHarnessQueryMetricRecord[];
  workspaceCount: number;
}): DBHarnessSemanticUpgradeEvaluation {
  const metrics = input.metrics;
  if (metrics.length === 0) {
    return {
      score: 0.3,
      baselineScore: 0.3,
      schemaHitRate: 0,
      sqlSuccessRate: 0,
      emptyRate: 0,
      correctiveRate: 0,
      errorMappingRate: 0,
      avgLatencyMs: 0,
      avgValidationScore: 0,
      notes: ['当前数据源暂无可用样本。'],
    };
  }

  const successRate = metrics.filter((metric) => metric.outcome === 'success').length / metrics.length;
  const emptyRate = metrics.filter((metric) => metric.outcome === 'empty').length / metrics.length;
  const correctiveRate = metrics.filter((metric) => metric.feedbackLabel === 'corrective').length / metrics.length;
  const avgValidationScore = metrics.reduce((sum, metric) => sum + (metric.validationScore || 0.5), 0) / metrics.length;
  const avgLatencyMs = metrics.reduce((sum, metric) => sum + (metric.agentTelemetry.query?.latencyMs || 0), 0) / metrics.length;
  const schemaHitRate = metrics.filter((metric) => metric.labels.some((label) => label === 'validation-pass')).length / metrics.length;
  const errorMappingRate = metrics.filter((metric) => metric.labels.some((label) => label === 'validation-fail')).length / metrics.length;
  const baselineScore = clamp01(metrics.reduce((sum, metric) => sum + metric.confidence, 0) / metrics.length);
  const score = clamp01(
    baselineScore * 0.42
    + successRate * 0.28
    + schemaHitRate * 0.2
    + avgValidationScore * 0.15
    - emptyRate * 0.14
    - correctiveRate * 0.12
    - errorMappingRate * 0.15
  );

  return {
    score,
    baselineScore,
    schemaHitRate: Number(schemaHitRate.toFixed(4)),
    sqlSuccessRate: Number(successRate.toFixed(4)),
    emptyRate: Number(emptyRate.toFixed(4)),
    correctiveRate: Number(correctiveRate.toFixed(4)),
    errorMappingRate: Number(errorMappingRate.toFixed(4)),
    avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
    avgValidationScore: Number(avgValidationScore.toFixed(4)),
    notes: [
      `覆盖 workspace: ${input.workspaceCount}`,
      `样本量: ${metrics.length}`,
      `成功率: ${(successRate * 100).toFixed(1)}%`,
    ],
  };
}

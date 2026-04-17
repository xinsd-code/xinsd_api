import { DBHarnessExecutionPayload, DBHarnessExecutionValidation, DBHarnessExecutionValidationIssue, DBHarnessQueryPlan } from '../core/types';

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeColumn(value: string) {
  return value.trim().toLowerCase();
}

function includesColumn(columns: string[], column: string) {
  const target = normalizeColumn(column);
  return columns.some((item) => normalizeColumn(item) === target || normalizeColumn(item).endsWith(`.${target}`));
}

export function validateExecutionResult(
  question: string,
  plan: DBHarnessQueryPlan,
  execution: DBHarnessExecutionPayload
): DBHarnessExecutionValidation {
  const issues: DBHarnessExecutionValidationIssue[] = [];
  const columns = execution.columns || [];
  let score = 0.82;

  if (columns.length === 0) {
    score -= 0.45;
    issues.push({
      code: 'empty-columns',
      severity: 'warning',
      message: '当前结果没有可返回的字段，建议检查查询计划与数据源映射。',
    });
  }

  if (execution.rows.length === 0) {
    score -= 0.35;
    issues.push({
      code: 'empty-result',
      severity: 'warning',
      message: '当前查询执行成功，但没有命中数据行。',
    });
  }

  const missingMetrics = plan.metrics
    .filter((metric) => !includesColumn(columns, metric.column))
    .map((metric) => metric.label);
  if (missingMetrics.length > 0) {
    score -= Math.min(0.18, missingMetrics.length * 0.08);
    issues.push({
      code: 'missing-metrics',
      severity: 'warning',
      message: `结果里没有直接看到这些指标字段：${missingMetrics.slice(0, 3).join('、')}。`,
    });
  }

  const missingDimensions = plan.dimensions
    .filter((dimension) => !includesColumn(columns, dimension.column))
    .map((dimension) => dimension.label);
  if (missingDimensions.length > 0) {
    score -= Math.min(0.14, missingDimensions.length * 0.06);
    issues.push({
      code: 'missing-dimensions',
      severity: 'warning',
      message: `结果里没有直接看到这些维度字段：${missingDimensions.slice(0, 3).join('、')}。`,
    });
  }

  const numericColumns = columns.filter((column) =>
    execution.rows.some((row) => typeof row[column] === 'number')
  );
  if (plan.metrics.length > 0 && numericColumns.length === 0 && execution.rows.length > 0) {
    score -= 0.12;
    issues.push({
      code: 'no-numeric-column',
      severity: 'warning',
      message: '当前结果存在数据行，但没有发现明显的数值型指标列。',
    });
  }

  if (plan.dimensions.length > 0 && execution.rows.length === 1) {
    issues.push({
      code: 'single-row-dimension',
      severity: 'info',
      message: '问句包含分组维度，但当前预览只有 1 行，建议确认是否需要放宽筛选或继续下钻。',
    });
    score -= 0.04;
  }

  if (/\b(同比|环比|趋势|top|排名)\b/i.test(question) && execution.rows.length < 2) {
    issues.push({
      code: 'thin-analytical-result',
      severity: 'info',
      message: '当前问句更像分析型问题，但返回样本较少，建议进一步核对筛选条件。',
    });
    score -= 0.03;
  }

  const normalizedScore = Number(clampScore(score).toFixed(3));
  const status = normalizedScore >= 0.74
    ? 'pass'
    : normalizedScore >= 0.46
      ? 'review'
      : 'fail';
  const summary = status === 'pass'
    ? '结果校验通过，当前预览和查询计划基本一致。'
    : status === 'review'
      ? `结果可用，但发现 ${issues.length} 个需要留意的信号。`
      : '结果存在较高风险，建议先调整问句、口径或筛选条件。';

  return {
    status,
    score: normalizedScore,
    summary,
    issues,
  };
}

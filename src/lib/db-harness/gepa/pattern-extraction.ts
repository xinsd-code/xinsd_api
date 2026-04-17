import type {
  DBHarnessPromptTemplateRecord,
  DBHarnessQueryMetricRecord,
} from '../core/types';

export interface DBHarnessGepaPatternCandidate {
  id: string;
  title: string;
  description: string;
  promptPatch: string;
  compressionLevel: 'standard' | 'compact' | 'minimal';
  nerTopK: number;
  signal: string;
  labels: string[];
  confidence: number;
}

export interface DBHarnessGepaPatternSummary {
  totalMetrics: number;
  successCount: number;
  emptyCount: number;
  errorCount: number;
  fromCacheCount: number;
  averageConfidence: number;
  regressionSignal: boolean;
  topLabels: Array<{ label: string; count: number }>;
  topFingerprints: Array<{ fingerprint: string; count: number }>;
  notes: string[];
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function buildLabelSummary(metrics: DBHarnessQueryMetricRecord[]) {
  const counts = new Map<string, number>();
  metrics.forEach((metric) => {
    metric.labels.forEach((label) => {
      const normalized = normalizeLabel(label);
      if (!normalized) return;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));
}

function buildFingerprintSummary(metrics: DBHarnessQueryMetricRecord[]) {
  const counts = new Map<string, number>();
  metrics.forEach((metric) => {
    const fingerprint = metric.queryFingerprint.trim();
    if (!fingerprint) return;
    counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
  });
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([fingerprint, count]) => ({ fingerprint, count }));
}

export function buildGepaPatternSummary(metrics: DBHarnessQueryMetricRecord[]): DBHarnessGepaPatternSummary {
  const totalMetrics = metrics.length;
  const successCount = metrics.filter((metric) => metric.outcome === 'success').length;
  const emptyCount = metrics.filter((metric) => metric.outcome === 'empty').length;
  const errorCount = metrics.filter((metric) => metric.outcome === 'error').length;
  const fromCacheCount = metrics.filter((metric) => metric.fromCache).length;
  const averageConfidence = totalMetrics > 0
    ? metrics.reduce((sum, metric) => sum + metric.confidence, 0) / totalMetrics
    : 0;
  const regressionSignal = totalMetrics > 0 && (
    emptyCount + errorCount >= Math.max(2, Math.ceil(totalMetrics * 0.35))
    || averageConfidence < 0.72
    || buildFingerprintSummary(metrics).length > 0
  );

  const topLabels = buildLabelSummary(metrics);
  const topFingerprints = buildFingerprintSummary(metrics);
  const notes = [
    regressionSignal ? '近期存在回退/失败信号，已启用模式抽取候选。' : '',
    topFingerprints.length > 0 ? `发现 ${topFingerprints.length} 个重复 fingerprint，优先检查重复模式。` : '',
    fromCacheCount > 0 ? `${fromCacheCount} 条记录命中缓存，可结合缓存验证稳定性。` : '',
  ].filter(Boolean);

  return {
    totalMetrics,
    successCount,
    emptyCount,
    errorCount,
    fromCacheCount,
    averageConfidence: Number(clampConfidence(averageConfidence).toFixed(3)),
    regressionSignal,
    topLabels,
    topFingerprints,
    notes,
  };
}

export function buildGepaPatternCandidates(input: {
  metrics: DBHarnessQueryMetricRecord[];
  templates: DBHarnessPromptTemplateRecord[];
  limit?: number;
}): DBHarnessGepaPatternCandidate[] {
  const summary = buildGepaPatternSummary(input.metrics);
  if (!summary.regressionSignal) {
    return [];
  }

  const candidates: DBHarnessGepaPatternCandidate[] = [];
  const topLabel = summary.topLabels[0]?.label || '';
  const duplicateFingerprint = summary.topFingerprints[0]?.fingerprint || '';
  const hasHighConfidenceTemplate = input.templates.some((template) => template.confidence >= 0.78);

  if (summary.emptyCount > 0 || topLabel.includes('empty')) {
    candidates.push({
      id: 'pattern-empty-recovery',
      title: '空结果回收',
      description: '连续空结果时收窄候选与时间范围，优先复用高置信度模板。',
      promptPatch: '当最近回合出现空结果时，先收窄时间范围与候选表，再检查是否有可复用的高置信度模板。',
      compressionLevel: 'compact',
      nerTopK: 18,
      signal: `emptyCount=${summary.emptyCount};label=${topLabel || 'none'}`,
      labels: ['empty-result', topLabel].filter(Boolean),
      confidence: clampConfidence(0.82 + Math.min(0.08, summary.emptyCount * 0.02)),
    });
  }

  if (summary.errorCount > 0 || topLabel.includes('error')) {
    candidates.push({
      id: 'pattern-error-guard',
      title: '错误回退保护',
      description: '当规划或执行出错时，优先保持 Schema/纠正规则，减少激进收缩。',
      promptPatch: '若近期出现执行错误，保留现有 Schema 规则和纠正规则，优先检查字段映射与 SQL 安全校验。',
      compressionLevel: 'standard',
      nerTopK: 20,
      signal: `errorCount=${summary.errorCount};label=${topLabel || 'none'}`,
      labels: ['error', topLabel].filter(Boolean),
      confidence: clampConfidence(0.8 + Math.min(0.06, summary.errorCount * 0.015)),
    });
  }

  if ((summary.averageConfidence < 0.75 || duplicateFingerprint) && hasHighConfidenceTemplate) {
    candidates.push({
      id: 'pattern-template-reuse',
      title: '模板优先复用',
      description: '在置信度下降时优先复用已验证模板，减少无效探索。',
      promptPatch: '若近期平均置信度下降，优先复用已有高置信度模板，并将新候选收敛到最相关的语义模式。',
      compressionLevel: 'compact',
      nerTopK: 20,
      signal: `avgConfidence=${summary.averageConfidence.toFixed(3)};duplicateFingerprint=${duplicateFingerprint ? 'yes' : 'no'}`,
      labels: ['template', duplicateFingerprint ? 'duplicate-fingerprint' : 'low-confidence'],
      confidence: clampConfidence(0.79 + (hasHighConfidenceTemplate ? 0.04 : 0)),
    });
  }

  return candidates.slice(0, Math.max(1, Math.min(input.limit || 3, 4)));
}

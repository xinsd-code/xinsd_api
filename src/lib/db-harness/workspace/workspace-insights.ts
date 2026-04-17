import type { DBHarnessKnowledgeMemoryEntry, DBHarnessKnowledgeQualitySnapshot, DBHarnessWorkspaceFreshnessSnapshot } from '../core/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_MS = 7 * DAY_MS;
const FRESH_THRESHOLD_MS = 3 * DAY_MS;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseTime(value?: string): number | null {
  if (!value || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAge(ageMs: number): string {
  if (ageMs < DAY_MS) return '1天内';
  if (ageMs < 7 * DAY_MS) return '1周内';
  if (ageMs < 30 * DAY_MS) return '1个月内';
  return '1个月以上';
}

function scoreKnowledgeEntryQuality(entry: DBHarnessKnowledgeMemoryEntry): number {
  const summary = entry.summary.trim();
  const tagCount = entry.tags.length;
  const summaryScore = summary.length >= 80 ? 1.1 : summary.length >= 40 ? 0.8 : summary.length >= 20 ? 0.45 : 0.2;
  const tagScore = Math.min(tagCount, 6) * 0.18;
  const correctionScore = entry.correctionRule ? 1.4 : 0;
  const feedbackScore = entry.feedbackType === 'corrective' ? 0.9 : entry.feedbackType === 'positive' ? 0.5 : 0;
  const sourceScore = entry.source === 'schema' ? 0.25 : 0.1;
  const ageParsed = parseTime(entry.updatedAt);
  const ageMs = ageParsed ? Math.max(0, Date.now() - ageParsed) : 0;
  const recencyScore = ageMs > 30 * DAY_MS ? -0.35 : ageMs > 7 * DAY_MS ? -0.12 : 0.18;
  return summaryScore + tagScore + correctionScore + feedbackScore + sourceScore + recencyScore;
}

export function buildWorkspaceFreshnessSnapshot(input: {
  workspaceUpdatedAt?: string;
  databaseUpdatedAt?: string;
  semanticModelUpdatedAt?: string;
  cacheBuiltAt?: string;
  resolvedAt?: string;
}): DBHarnessWorkspaceFreshnessSnapshot {
  const resolvedAt = input.resolvedAt || new Date().toISOString();
  const resolvedTime = Date.parse(resolvedAt);
  const sourceTimes = [
    parseTime(input.workspaceUpdatedAt),
    parseTime(input.databaseUpdatedAt),
    parseTime(input.semanticModelUpdatedAt),
  ].filter((value): value is number => Number.isFinite(value as number));
  const sourceUpdatedAt = sourceTimes.length > 0
    ? new Date(Math.max(...sourceTimes)).toISOString()
    : undefined;
  const sourceAgeMs = sourceUpdatedAt ? Math.max(0, resolvedTime - Date.parse(sourceUpdatedAt)) : 0;
  const notes: string[] = [];

  if (input.semanticModelUpdatedAt && input.databaseUpdatedAt) {
    const semanticTime = Date.parse(input.semanticModelUpdatedAt);
    const databaseTime = Date.parse(input.databaseUpdatedAt);
    if (Number.isFinite(semanticTime) && Number.isFinite(databaseTime) && semanticTime < databaseTime) {
      notes.push('语义模型更新时间早于数据源更新时间，建议优先刷新语义映射。');
    }
  }

  if (input.workspaceUpdatedAt && input.cacheBuiltAt) {
    const workspaceTime = Date.parse(input.workspaceUpdatedAt);
    const cacheTime = Date.parse(input.cacheBuiltAt);
    if (Number.isFinite(workspaceTime) && Number.isFinite(cacheTime) && cacheTime < workspaceTime) {
      notes.push('Workspace 配置已更新，当前缓存应视为旧快照。');
    }
  }

  const freshnessScore = clamp01(
    sourceUpdatedAt
      ? 1 - Math.min(1, sourceAgeMs / (30 * DAY_MS))
      : 0.55
  );
  const stale = sourceAgeMs > STALE_THRESHOLD_MS || notes.length > 0;

  if (sourceAgeMs <= FRESH_THRESHOLD_MS) {
    notes.push('Schema 相关数据较新，可优先使用当前上下文。');
  } else if (sourceAgeMs > STALE_THRESHOLD_MS) {
    notes.push(`Schema 相关数据已超过 ${formatAge(STALE_THRESHOLD_MS)}，建议在后续回合谨慎依赖。`);
  }

  return {
    resolvedAt,
    workspaceUpdatedAt: input.workspaceUpdatedAt,
    databaseUpdatedAt: input.databaseUpdatedAt,
    semanticModelUpdatedAt: input.semanticModelUpdatedAt,
    sourceUpdatedAt,
    cacheBuiltAt: input.cacheBuiltAt,
    ageMs: sourceAgeMs,
    freshnessScore: Number(freshnessScore.toFixed(3)),
    stale,
    notes,
  };
}

export function buildKnowledgeQualitySnapshot(entries: DBHarnessKnowledgeMemoryEntry[]): DBHarnessKnowledgeQualitySnapshot {
  const totalEntries = entries.length;
  const positiveEntries = entries.filter((entry) => entry.feedbackType === 'positive').length;
  const correctiveEntries = entries.filter((entry) => entry.feedbackType === 'corrective').length;
  const correctionRuleEntries = entries.filter((entry) => Boolean(entry.correctionRule)).length;
  const freshEntries = entries.filter((entry) => {
    const parsed = parseTime(entry.updatedAt);
    return parsed ? Date.now() - parsed <= 7 * DAY_MS : false;
  }).length;
  const lowSignalEntries = entries.filter((entry) => scoreKnowledgeEntryQuality(entry) < 1.35).length;
  const averageTagCount = totalEntries > 0
    ? entries.reduce((sum, entry) => sum + entry.tags.length, 0) / totalEntries
    : 0;
  const qualityScore = totalEntries > 0
    ? clamp01(
        (positiveEntries * 1.2
        + correctiveEntries * 1.35
        + correctionRuleEntries * 1.75
        + freshEntries * 0.9
        - lowSignalEntries * 0.35)
        / (totalEntries * 2)
      )
    : 0;
  const notes = [
    correctionRuleEntries > 0 ? '已存在结构化纠正规则，可优先复用高价值记忆。' : '',
    lowSignalEntries > 0 ? `存在 ${lowSignalEntries} 条低信号记忆，后续检索会自动降权。` : '',
    freshEntries > 0 ? `${freshEntries} 条记忆在最近 7 天内更新。` : '',
  ].filter(Boolean);

  return {
    totalEntries,
    positiveEntries,
    correctiveEntries,
    correctionRuleEntries,
    freshEntries,
    lowSignalEntries,
    averageTagCount: Number(averageTagCount.toFixed(2)),
    qualityScore: Number(qualityScore.toFixed(3)),
    notes,
  };
}

export function measureKnowledgeEntryQuality(entry: DBHarnessKnowledgeMemoryEntry): number {
  return Number(scoreKnowledgeEntryQuality(entry).toFixed(3));
}

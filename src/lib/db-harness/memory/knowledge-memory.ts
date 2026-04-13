import { DatabaseMetricViewMap, DBHarnessKnowledgeMemoryEntry, DBHarnessNerPayload, DBHarnessTurnArtifact } from '../core/types';
import { buildKeywordSet, dedupeStrings, scoreTextByKeywords, truncateText } from '../core/utils';
import { DatabaseSchemaPayload } from '@/lib/types';

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /email/i,
  /phone/i,
  /mobile/i,
  /身份证/,
  /手机号/,
  /id[_-]?card/i,
  /ssn/i,
];

export function deriveKnowledgeEntries(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  nerPayload: DBHarnessNerPayload
): DBHarnessKnowledgeMemoryEntry[] {
  const entries = new Map<string, DBHarnessKnowledgeMemoryEntry>();

  schema.collections
    .filter((collection) => collection.category === 'table')
    .forEach((collection) => {
      const tableMetrics = metricMappings[collection.name];
      (collection.columns || []).forEach((column) => {
        const metric = tableMetrics?.fields?.[column.name];
        const tags = dedupeStrings([
          collection.name,
          column.name,
          metric?.metricName,
          ...(metric?.aliases || []),
        ], 24);

        const sensitive = tags.some((item) => SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(item)));
        if (!metric && !sensitive) return;

        const key = `${collection.name}.${column.name}`;
        entries.set(key, {
          key,
          summary: sensitive
            ? `${key} 被识别为敏感字段边界，应避免出现在最终 SQL 中。`
            : `${key} 可作为业务映射候选，指标名为 ${metric?.metricName || column.name}。`,
          tags,
        });
      });
    });

  nerPayload.matchedMetrics.forEach((item) => {
    const key = `${item.table}.${item.column}`;
    const current = entries.get(key);
    entries.set(key, {
      key,
      summary: current?.summary || `${key} 命中了当前问句中的语义映射。`,
      tags: dedupeStrings([
        ...(current?.tags || []),
        item.term,
        item.metricName,
        item.confidence,
      ], 24),
    });
  });

  return Array.from(entries.values()).slice(0, 16);
}

export function mergeKnowledgeEntries(...groups: DBHarnessKnowledgeMemoryEntry[][]): DBHarnessKnowledgeMemoryEntry[] {
  const entries = new Map<string, DBHarnessKnowledgeMemoryEntry>();

  groups.flat().forEach((entry) => {
    const key = entry.key.trim();
    if (!key) return;
    const current = entries.get(key);
    entries.set(key, {
      key,
      summary: entry.summary.trim() || current?.summary || key,
      tags: dedupeStrings([...(current?.tags || []), ...(entry.tags || [])], 24).slice(0, 24),
      source: entry.source || current?.source,
      feedbackType: entry.feedbackType || current?.feedbackType,
      updatedAt: entry.updatedAt || current?.updatedAt,
    });
  });

  return Array.from(entries.values()).slice(0, 24);
}

export function buildKnowledgeOverview(
  entries: DBHarnessKnowledgeMemoryEntry[],
  keywords: Set<string>,
  limit = 8
) {
  return entries
    .map((entry) => ({
      score: scoreTextByKeywords(entry.summary, keywords)
        + entry.tags.reduce((sum, tag) => sum + scoreTextByKeywords(tag, keywords), 0)
        + (entry.feedbackType === 'corrective' ? 4 : entry.feedbackType === 'positive' ? 2 : 0),
      payload: {
        key: entry.key,
        summary: truncateText(entry.summary, 160) || entry.key,
        tags: entry.tags.slice(0, 6),
        source: entry.source || 'feedback',
        feedbackType: entry.feedbackType,
      },
      updatedAt: Date.parse(entry.updatedAt || '') || 0,
    }))
    .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt || left.payload.key.localeCompare(right.payload.key))
    .slice(0, limit)
    .map((item) => item.payload);
}

export function createFeedbackKnowledgeEntry(input: {
  question: string;
  feedbackType: 'positive' | 'corrective';
  note?: string;
  artifact?: DBHarnessTurnArtifact;
}): DBHarnessKnowledgeMemoryEntry {
  const keywords = buildKeywordSet(
    input.question,
    input.note,
    input.artifact?.planSummary,
    input.artifact?.sql,
    input.artifact?.summary
  );
  const targetTable = input.artifact?.queryPlan?.targetTable || '';
  const metricLabels = input.artifact?.queryPlan?.metrics?.map((item) => item.label).slice(0, 4) || [];
  const dimensionLabels = input.artifact?.queryPlan?.dimensions?.map((item) => item.label).slice(0, 4) || [];
  const summaryParts = [
    input.feedbackType === 'positive' ? '该类问题的结果可复用。' : '该类问题需要优先按反馈纠偏。',
    targetTable ? `目标表：${targetTable}。` : '',
    metricLabels[0] ? `指标侧重：${metricLabels.join('、')}。` : '',
    dimensionLabels[0] ? `维度线索：${dimensionLabels.join('、')}。` : '',
    input.note ? `用户反馈：${input.note.trim()}。` : '',
  ].filter(Boolean);

  return {
    key: [
      'feedback',
      targetTable || 'general',
      input.feedbackType,
      Array.from(keywords).slice(0, 3).join('-') || 'memory',
    ].join(':'),
    summary: summaryParts.join(' '),
    tags: dedupeStrings([
      input.question,
      input.note,
      targetTable,
      ...(metricLabels || []),
      ...(dimensionLabels || []),
      ...(input.artifact?.semanticOverview?.focusEntities.flatMap((entity) => entity.metrics.slice(0, 2)) || []),
    ], 24).slice(0, 24),
    source: 'feedback',
    feedbackType: input.feedbackType,
    updatedAt: new Date().toISOString(),
  };
}

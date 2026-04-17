import {
  DatabaseMetricViewMap,
  DBHarnessFeedbackCorrectionMapping,
  DBHarnessFeedbackCorrectionRule,
  DBHarnessKnowledgeMemoryEntry,
  DBHarnessNerPayload,
  DBHarnessTurnArtifact,
} from '../core/types';
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

function summarizeCorrectionRule(rule: DBHarnessFeedbackCorrectionRule | undefined): string {
  if (!rule) return '';
  const wrong = [rule.wrongMapping.table, rule.wrongMapping.column].filter(Boolean).join('.');
  const correct = [rule.correctMapping.table, rule.correctMapping.column].filter(Boolean).join('.');
  const wrongLabel = rule.wrongMapping.label || wrong || '未知映射';
  const correctLabel = rule.correctMapping.label || correct || '未知映射';
  return `纠正规则：${wrongLabel} -> ${correctLabel}`;
}

function scoreKnowledgeEntryQuality(entry: DBHarnessKnowledgeMemoryEntry): number {
  const summary = entry.summary.trim();
  const tagCount = entry.tags.length;
  const summaryScore = summary.length >= 80 ? 1.1 : summary.length >= 40 ? 0.8 : summary.length >= 20 ? 0.45 : 0.2;
  const tagScore = Math.min(tagCount, 6) * 0.18;
  const correctionScore = entry.correctionRule ? 1.4 : 0;
  const feedbackScore = entry.feedbackType === 'corrective' ? 0.9 : entry.feedbackType === 'positive' ? 0.5 : 0;
  const sourceScore = entry.source === 'schema' ? 0.25 : 0.1;
  const ageParsed = Date.parse(entry.updatedAt || '');
  const ageMs = Number.isFinite(ageParsed) ? Math.max(0, Date.now() - ageParsed) : 0;
  const recencyScore = ageMs > 30 * 24 * 60 * 60 * 1000 ? -0.35 : ageMs > 7 * 24 * 60 * 60 * 1000 ? -0.12 : 0.18;
  return summaryScore + tagScore + correctionScore + feedbackScore + sourceScore + recencyScore;
}

function extractMappingFromArtifact(artifact: DBHarnessTurnArtifact | undefined): DBHarnessFeedbackCorrectionMapping {
  const queryPlan = artifact?.queryPlan;
  const metric = queryPlan?.metrics?.[0];
  const dimension = queryPlan?.dimensions?.[0];
  const target = metric || dimension;

  if (!target) {
    return {
      label: artifact?.summary || artifact?.sql || '未提供具体映射',
    };
  }

  return {
    table: target.table,
    column: target.column,
    label: target.label,
  };
}

function extractCorrectionRule(input: {
  note?: string;
  artifact?: DBHarnessTurnArtifact;
}): DBHarnessFeedbackCorrectionRule | undefined {
  if (!input.note?.trim()) return undefined;
  const wrongMapping = extractMappingFromArtifact(input.artifact);
  const note = input.note.trim();
  const hintedLabel = note.replace(/\s+/g, ' ').slice(0, 60);
  return {
    wrongMapping,
    correctMapping: {
      label: hintedLabel || '用户确认需要修正映射',
    },
    note,
    source: 'inferred',
  };
}

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
      correctionRule: entry.correctionRule || current?.correctionRule,
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
        + (entry.correctionRule ? 3 : 0)
        + (entry.feedbackType === 'corrective' ? 4 : entry.feedbackType === 'positive' ? 2 : 0),
      quality: scoreKnowledgeEntryQuality(entry),
      payload: {
        key: entry.key,
        summary: truncateText(entry.summary, 160) || entry.key,
        tags: entry.tags.slice(0, 6),
        source: entry.source || 'feedback',
        feedbackType: entry.feedbackType,
        correctionRule: entry.correctionRule,
      },
      updatedAt: Date.parse(entry.updatedAt || '') || 0,
    }))
    .sort((left, right) => right.score - left.score || right.quality - left.quality || right.updatedAt - left.updatedAt || left.payload.key.localeCompare(right.payload.key))
    .slice(0, limit)
    .map((item) => item.payload);
}

export function buildCorrectionRuleOverview(
  entries: DBHarnessKnowledgeMemoryEntry[],
  keywords: Set<string>,
  limit = 6
) {
  return entries
    .filter((entry) => entry.correctionRule)
    .map((entry) => ({
      score: scoreTextByKeywords(entry.summary, keywords)
        + entry.tags.reduce((sum, tag) => sum + scoreTextByKeywords(tag, keywords), 0)
        + 10,
      payload: {
        key: entry.key,
        rule: entry.correctionRule,
        summary: summarizeCorrectionRule(entry.correctionRule),
        note: entry.correctionRule?.note,
      },
      updatedAt: Date.parse(entry.updatedAt || '') || 0,
    }))
    .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt || left.payload.key.localeCompare(right.payload.key))
    .slice(0, limit)
    .map((item) => item.payload);
}

export function buildKnowledgeQualityOverview(entries: DBHarnessKnowledgeMemoryEntry[]) {
  const totalEntries = entries.length;
  const positiveEntries = entries.filter((entry) => entry.feedbackType === 'positive').length;
  const correctiveEntries = entries.filter((entry) => entry.feedbackType === 'corrective').length;
  const correctionRuleEntries = entries.filter((entry) => Boolean(entry.correctionRule)).length;
  const freshEntries = entries.filter((entry) => {
    const updatedAt = Date.parse(entry.updatedAt || '');
    return Number.isFinite(updatedAt) && Date.now() - updatedAt <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const lowSignalEntries = entries.filter((entry) => scoreKnowledgeEntryQuality(entry) < 1.35).length;
  const averageTagCount = totalEntries > 0
    ? entries.reduce((sum, entry) => sum + entry.tags.length, 0) / totalEntries
    : 0;

  return {
    totalEntries,
    positiveEntries,
    correctiveEntries,
    correctionRuleEntries,
    freshEntries,
    lowSignalEntries,
    averageTagCount: Number(averageTagCount.toFixed(2)),
    notes: [
      correctionRuleEntries > 0 ? '结构化纠正规则已可用于记忆优先级排序。' : '',
      lowSignalEntries > 0 ? `有 ${lowSignalEntries} 条低信号记忆，会在检索中自动降权。` : '',
    ].filter(Boolean),
  };
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
  const correctionRule = input.feedbackType === 'corrective'
    ? extractCorrectionRule({
        note: input.note,
        artifact: input.artifact,
      })
    : undefined;
  const summaryParts = [
    input.feedbackType === 'positive' ? '该类问题的结果可复用。' : '该类问题需要优先按反馈纠偏。',
    targetTable ? `目标表：${targetTable}。` : '',
    metricLabels[0] ? `指标侧重：${metricLabels.join('、')}。` : '',
    dimensionLabels[0] ? `维度线索：${dimensionLabels.join('、')}。` : '',
    input.note ? `用户反馈：${input.note.trim()}。` : '',
    correctionRule ? summarizeCorrectionRule(correctionRule) : '',
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
      correctionRule?.correctMapping.label,
    ], 24).slice(0, 24),
    source: 'feedback',
    feedbackType: input.feedbackType,
    updatedAt: new Date().toISOString(),
    correctionRule,
  };
}

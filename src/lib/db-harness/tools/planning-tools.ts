import { normalizeSqlForExecution } from '@/lib/sql-normalize';
import { DatabaseSchemaPayload } from '@/lib/types';
import {
  DBHarnessAiPayload,
  DBHarnessPlanningHints,
  DBHarnessNerCandidate,
  DBHarnessNerPayload,
  DBHarnessQueryPlan,
  DBHarnessQueryPlanDimension,
  DBHarnessQueryPlanFilter,
  DBHarnessQueryPlanMetric,
  DBHarnessQueryResult,
  DBHarnessSessionContext,
  DBHarnessWorkspaceContext,
  DatabaseMetricViewMap,
} from '../core/types';
import {
  buildKeywordSet,
  compactJson,
  compactText,
  dedupeStrings,
  extractTimeRangeDays,
  isDateLikeType,
  isNumericType,
  isRecord,
  isTextLikeType,
  parseJsonSafely,
  quoteIdentifier,
  scoreTextByKeywords,
  truncateText,
} from '../core/utils';
import { buildCatalogOverview, buildSemanticOverview } from './catalog-tools';
import { buildKnowledgeOverview } from '../memory/knowledge-memory';

type QueryAggregate = DBHarnessQueryPlanMetric['aggregate'];
type QueryPromptCompressionLevel = 'standard' | 'compact' | 'minimal';
const DEFAULT_SCHEMA_OVERVIEW_TABLE_LIMIT = 8;

const QUERY_CONTEXT_LIMITS: Record<QueryPromptCompressionLevel, {
  rules: number;
  recentQuestions: number;
  planning: number;
  currentSql: number;
  schema: number;
  resultSummary: number;
  resultColumns: number;
  resultRows: number;
  catalog: number;
  semantic: number;
  knowledge: number;
  schemaOverview: number;
  resultColumnCount: number;
  resultRowCount: number;
}> = {
  standard: {
    rules: 900,
    recentQuestions: 700,
    planning: 1200,
    currentSql: 1000,
    schema: 1800,
    resultSummary: 240,
    resultColumns: 600,
    resultRows: 1200,
    catalog: 1800,
    semantic: 1800,
    knowledge: 1200,
    schemaOverview: 3600,
    resultColumnCount: 24,
    resultRowCount: 3,
  },
  compact: {
    rules: 600,
    recentQuestions: 480,
    planning: 900,
    currentSql: 720,
    schema: 1200,
    resultSummary: 180,
    resultColumns: 360,
    resultRows: 720,
    catalog: 1100,
    semantic: 1100,
    knowledge: 760,
    schemaOverview: 2200,
    resultColumnCount: 16,
    resultRowCount: 2,
  },
  minimal: {
    rules: 360,
    recentQuestions: 320,
    planning: 600,
    currentSql: 480,
    schema: 800,
    resultSummary: 120,
    resultColumns: 220,
    resultRows: 360,
    catalog: 700,
    semantic: 700,
    knowledge: 480,
    schemaOverview: 1400,
    resultColumnCount: 10,
    resultRowCount: 1,
  },
};

function quoteSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) {
    return `(${value.map((item) => quoteSqlLiteral(item)).join(', ')})`;
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${raw.replace(/'/g, "''")}'`;
}

function normalizeAggregate(value: unknown): QueryAggregate | null {
  if (value === 'count' || value === 'sum' || value === 'avg' || value === 'max' || value === 'min' || value === 'value') {
    return value;
  }
  return null;
}

function buildSchemaOverview(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  keywords: Set<string>,
  tableLimit = DEFAULT_SCHEMA_OVERVIEW_TABLE_LIMIT
): unknown {
  const tables = (schema.collections || [])
    .filter((collection) => collection.category === 'table')
    .map((collection) => {
      const tableMetrics = metricMappings[collection.name];
      const tableScore = scoreTextByKeywords(collection.name, keywords)
        + scoreTextByKeywords(tableMetrics?.description, keywords)
        + Object.keys(tableMetrics?.fields || {}).length;

      const columns = (collection.columns || [])
        .map((column) => {
          const metric = tableMetrics?.fields?.[column.name];
          const columnScore = scoreTextByKeywords(column.name, keywords)
            + scoreTextByKeywords(metric?.metricName, keywords)
            + scoreTextByKeywords(metric?.description, keywords)
            + (metric?.enableForNer ? 1 : 0)
            + (metric ? 4 : 0)
            + (column.isPrimary ? 1 : 0);

          return {
            score: columnScore,
            payload: {
              name: column.name,
              type: column.type,
              pk: column.isPrimary || undefined,
              metricName: truncateText(metric?.metricName, 40),
              metricDesc: truncateText(metric?.description, 70),
              metricType: truncateText(metric?.metricType, 30),
              calcMode: truncateText(metric?.calcMode, 30),
              aliases: metric?.aliases?.slice(0, 3),
              ner: metric?.enableForNer || undefined,
              referencesTable: column.referencesTable || undefined,
            },
          };
        })
        .sort((left, right) => right.score - left.score || left.payload.name.localeCompare(right.payload.name))
        .slice(0, 10)
        .map((item) => item.payload);

      return {
        score: tableScore,
        payload: {
          table: collection.name,
          desc: truncateText(tableMetrics?.description, 80),
          columns,
        },
      };
    })
    .sort((left, right) => right.score - left.score || left.payload.table.localeCompare(right.payload.table))
    .slice(0, Math.max(2, Math.min(tableLimit, 12)))
    .map((item) => item.payload);

  return {
    engine: schema.engine,
    tableCount: schema.collections.filter((item) => item.category === 'table').length,
    focusTables: tables,
  };
}

export function inferIntent(question: string): string {
  const text = question.toLowerCase();
  if (/对比|同比|环比|compare/.test(text)) return 'comparison';
  if (/趋势|变化|trend/.test(text)) return 'analysis';
  if (/诊断|原因/.test(text)) return 'diagnosis';
  if (/图|chart|可视化/.test(text)) return 'visualization';
  return 'query';
}

export function sanitizePlanningHints(input: unknown): DBHarnessPlanningHints {
  const source = isRecord(input) ? input : {};
  const sanitizeTextList = (value: unknown, max = 8) => (
    Array.isArray(value)
      ? dedupeStrings(value.map((item) => (typeof item === 'string' ? item : '')), 60).slice(0, max)
      : []
  );
  const timeRangeDays = Number.parseInt(String(source.timeRangeDays ?? ''), 10);

  return {
    intent: typeof source.intent === 'string' && source.intent.trim() ? source.intent.trim() : 'query',
    candidateTables: sanitizeTextList(source.candidateTables, 6),
    dimensions: sanitizeTextList(source.dimensions, 8),
    metrics: sanitizeTextList(source.metrics, 8),
    filters: sanitizeTextList(source.filters, 8),
    timeRangeDays: Number.isFinite(timeRangeDays) && timeRangeDays > 0 ? Math.min(timeRangeDays, 3650) : null,
    notes: sanitizeTextList(source.notes, 6),
  };
}

export function buildFallbackPlanningHints(
  question: string,
  workspace: DBHarnessWorkspaceContext
): DBHarnessPlanningHints {
  const keywords = buildKeywordSet(question);
  const catalogOverview = buildCatalogOverview(workspace.catalog, keywords);
  const semanticOverview = buildSemanticOverview(workspace.semantic, keywords);
  const focusCatalogEntities = catalogOverview.focusEntities;
  const focusSemanticEntities = semanticOverview.focusEntities;

  const candidateTables = focusCatalogEntities
    .map((entity) => entity.table)
    .filter(Boolean)
    .slice(0, 4);
  const dimensions = dedupeStrings(
    focusSemanticEntities.flatMap((entity) => (
      entity.dimensions
    )),
    60
  ).slice(0, 6);
  const metrics = dedupeStrings(
    focusSemanticEntities.flatMap((entity) => (
      entity.metrics
    )),
    60
  ).slice(0, 6);

  const timeRangeDays = extractTimeRangeDays(question);
  const filters = timeRangeDays ? [`最近${timeRangeDays}天`] : [];

  return {
    intent: inferIntent(question),
    candidateTables,
    dimensions,
    metrics,
    filters,
    timeRangeDays,
    notes: dedupeStrings([
      candidateTables[0] ? `优先围绕 ${candidateTables[0]} 规划` : '',
      metrics[0] ? `优先确认指标 ${metrics[0]}` : '',
      dimensions[0] ? `可考虑按 ${dimensions[0]} 展开` : '',
    ], 60).slice(0, 4),
  };
}

export function buildIntentDetail(
  hints: DBHarnessPlanningHints,
  datasourceName: string
): string {
  const focus = hints.candidateTables[0] || datasourceName;
  const metric = hints.metrics[0];
  const dimension = hints.dimensions[0];
  const parts = [
    `已结合当前问句与语义快照，确认本轮意图为 ${hints.intent}`,
    `优先围绕 ${focus} 继续规划`,
    metric ? `重点指标为 ${metric}` : '',
    dimension ? `可优先关注维度 ${dimension}` : '',
  ].filter(Boolean);
  return `${parts.join('，')}。`;
}

export function buildIntentPromptContext(
  session: DBHarnessSessionContext,
  workspace: DBHarnessWorkspaceContext
): string {
  const keywords = buildKeywordSet(session.latestUserMessage, session.currentSql);
  const runtimePromptStrategy = workspace.runtimeConfig?.promptStrategy?.trim() || '';
  return [
    '动态上下文如下：',
    `Workspace ID: ${workspace.workspaceId || '未提供'}`,
    `数据库实例 ID: ${workspace.databaseInstance.id}`,
    `数据库名称: ${workspace.databaseInstance.name}`,
    `数据库类型: ${workspace.databaseInstance.type}`,
    'Workspace 规则：',
    compactText(workspace.workspaceRules || '未设置额外规则。', 1600),
    'GEPA Prompt 策略：',
    compactText(runtimePromptStrategy || '未启用额外 Prompt 策略。', 600),
    `用户原始问句: ${compactText(session.latestUserMessage, 320)}`,
    `最近 5 条问题: ${compactJson(session.recentQuestions, 1000)}`,
    '当前 SQL 草稿：',
    compactText(session.currentSql, 1200),
    '知识记忆摘要：',
    compactJson(buildKnowledgeOverview(workspace.knowledge, keywords), 1800),
    '轻量目录摘要：',
    compactJson(buildCatalogOverview(workspace.catalog, keywords), 3200),
    '轻量语义摘要：',
    compactJson(buildSemanticOverview(workspace.semantic, keywords), 3200),
  ].join('\n');
}

export function sanitizeAiPayload(input: unknown, databaseEngine: 'mysql' | 'pgsql'): DBHarnessAiPayload {
  const source = isRecord(input) ? input : {};
  const sql = typeof source.sql === 'string' ? source.sql.trim() : '';

  if (!sql) {
    throw new Error('AI 没有返回可用的 SQL');
  }

  return {
    message: typeof source.message === 'string' && source.message.trim()
      ? source.message.trim()
      : '已根据你的描述生成查询 SQL。',
    sql: normalizeSqlForExecution(databaseEngine, sql),
  };
}

function scoreCandidate(candidate: DBHarnessNerCandidate, keywords: Set<string>): number {
  let score = 0;
  score += scoreTextByKeywords(candidate.metricName, keywords) * 2;
  score += scoreTextByKeywords(candidate.column, keywords) * 2;
  score += scoreTextByKeywords(candidate.table, keywords);
  score += scoreTextByKeywords(candidate.description, keywords);
  candidate.aliases.forEach((alias) => {
    score += scoreTextByKeywords(alias, keywords) * 2;
  });
  if (candidate.metricName) score += 1;
  if (candidate.description) score += 1;
  return score;
}

function buildExpandedKeywordSet(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  keywords: Set<string>
): Set<string> {
  const expanded = new Set(keywords);

  schema.collections
    .filter((collection) => collection.category === 'table')
    .forEach((collection) => {
      const tableMetrics = metricMappings[collection.name];
      (collection.columns || []).forEach((column) => {
        const metric = tableMetrics?.fields?.[column.name];
        const terms = dedupeStrings([
          collection.name,
          column.name,
          column.comment,
          metric?.metricName,
          metric?.description,
          ...(metric?.aliases || []),
        ], 24);
        if (!terms.some((term) => scoreTextByKeywords(term, keywords) > 0)) {
          return;
        }
        terms.forEach((term) => {
          const normalized = term.trim().toLowerCase();
          if (normalized) {
            expanded.add(normalized);
          }
        });
      });
    });

  return expanded;
}

function determineNerCandidateLimit(keywordCount: number, totalAvailable: number, matchedCount: number): number {
  const base = keywordCount >= 10 || matchedCount >= 12
    ? 24
    : keywordCount >= 6 || matchedCount >= 8
      ? 20
      : 16;
  const scale = totalAvailable > 40 ? 4 : totalAvailable > 24 ? 2 : 0;
  return Math.min(32, Math.max(12, base + scale));
}

export function buildNerCandidateBundle(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  keywords: Set<string>,
  preferredLimit?: number | null
) {
  const allCandidates: DBHarnessNerCandidate[] = [];
  const expandedKeywords = buildExpandedKeywordSet(schema, metricMappings, keywords);

  schema.collections
    .filter((collection) => collection.category === 'table')
    .forEach((collection) => {
      const tableMetrics = metricMappings[collection.name];
      (collection.columns || []).forEach((column) => {
        const metric = tableMetrics?.fields?.[column.name];
        if (!metric?.enableForNer) return;

        allCandidates.push({
          table: collection.name,
          column: column.name,
          metricName: truncateText(metric.metricName, 40),
          description: truncateText(metric.description || column.comment || tableMetrics?.description, 40),
          aliases: dedupeStrings([
            ...(metric.aliases || []),
            metric.metricName,
            column.name,
            collection.name,
            column.comment,
          ], 18).slice(0, 4),
        });
      });
    });

  const sorted = allCandidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, expandedKeywords),
    }))
    .sort((left, right) => right.score - left.score
      || left.candidate.table.localeCompare(right.candidate.table)
      || left.candidate.column.localeCompare(right.candidate.column));

  const hardLimit = preferredLimit && Number.isFinite(preferredLimit)
    ? Math.max(8, Math.min(Math.trunc(preferredLimit), 32))
    : determineNerCandidateLimit(keywords.size, allCandidates.length, sorted.filter((item) => item.score > 0).length);
  const matched = keywords.size > 0 ? sorted.filter((item) => item.score > 0) : sorted;
  const chosen = (matched.length > 0 ? matched : sorted).slice(0, hardLimit).map((item) => item.candidate);

  return {
    totalAvailable: allCandidates.length,
    candidateCount: chosen.length,
    truncated: allCandidates.length > chosen.length,
    candidates: chosen,
  };
}

export function sanitizeNerPayload(input: unknown): DBHarnessNerPayload {
  const source = isRecord(input) ? input : {};
  const sanitizeTextList = (value: unknown, max = 12) => (
    Array.isArray(value)
      ? dedupeStrings(value.map((item) => (typeof item === 'string' ? item : '')), 40).slice(0, max)
      : []
  );

  const matchedMetrics = Array.isArray(source.matchedMetrics)
    ? source.matchedMetrics
      .filter(isRecord)
      .reduce<DBHarnessNerPayload['matchedMetrics']>((list, item) => {
        const confidence = item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low'
          ? item.confidence
          : 'medium';
        const term = typeof item.term === 'string' ? item.term.trim() : '';
        const table = typeof item.table === 'string' ? item.table.trim() : '';
        const column = typeof item.column === 'string' ? item.column.trim() : '';
        const metricName = typeof item.metricName === 'string' ? item.metricName.trim() : undefined;
        if (!term || !table || !column) return list;
        list.push({ term, table, column, metricName, confidence });
        return list;
      }, [])
      .slice(0, 12)
    : [];

  return {
    normalizedTerms: sanitizeTextList(source.normalizedTerms),
    matchedMetrics,
    unmatchedTerms: sanitizeTextList(source.unmatchedTerms),
    timeHints: sanitizeTextList(source.timeHints, 8),
    intent: typeof source.intent === 'string' && source.intent.trim() ? source.intent.trim() : 'query',
  };
}

export function buildSchemaDetail(
  nerPayload: DBHarnessNerPayload,
  candidates: ReturnType<typeof buildNerCandidateBundle>
): string {
  const matchedTables = Array.from(new Set(nerPayload.matchedMetrics.map((item) => item.table))).slice(0, 3);
  if (matchedTables.length > 0) {
    return `已围绕 ${matchedTables.join('、')} 汇总候选表结构，并确认 ${nerPayload.matchedMetrics.length} 个字段映射。`;
  }

  return `已检索 ${candidates.candidateCount} 个高相关 Schema 候选实体，当前以规则和语义摘要共同支撑后续规划。`;
}

export function buildSchemaPromptContext(
  session: DBHarnessSessionContext,
  workspace: DBHarnessWorkspaceContext,
  candidates: ReturnType<typeof buildNerCandidateBundle>
): string {
  const keywords = buildExpandedKeywordSet(
    workspace.schema,
    workspace.metricMappings,
    buildKeywordSet(session.latestUserMessage, session.currentSql)
  );
  return [
    '动态上下文如下：',
    `Workspace ID: ${workspace.workspaceId || '未提供'}`,
    `数据库实例 ID: ${workspace.databaseInstance.id}`,
    `数据库名称: ${workspace.databaseInstance.name}`,
    `数据库类型: ${workspace.databaseInstance.type}`,
    'Workspace 规则：',
    compactText(workspace.workspaceRules || '未设置额外规则。', 2000),
    'GEPA Prompt 策略：',
    compactText(workspace.runtimeConfig?.promptStrategy || '未启用额外 Prompt 策略。', 720),
    `用户原始问句: ${compactText(session.latestUserMessage, 320)}`,
    '当前 SQL 草稿：',
    compactText(session.currentSql, 1200),
    '知识记忆摘要：',
    compactJson(buildKnowledgeOverview(workspace.knowledge, keywords), 1800),
    '轻量目录摘要：',
    compactJson(buildCatalogOverview(workspace.catalog, keywords), 2600),
    '轻量语义摘要：',
    compactJson(buildSemanticOverview(workspace.semantic, keywords), 2600),
    'Schema Agent 候选实体：',
    compactJson(candidates, 3200),
  ].join('\n');
}

export function buildQueryPromptContext(
  session: DBHarnessSessionContext,
  workspace: DBHarnessWorkspaceContext,
  planningHints: DBHarnessPlanningHints,
  nerPayload: DBHarnessNerPayload,
  compressionLevel: QueryPromptCompressionLevel = 'standard'
): string {
  const limits = QUERY_CONTEXT_LIMITS[compressionLevel];
  const keywords = buildExpandedKeywordSet(
    workspace.schema,
    workspace.metricMappings,
    buildKeywordSet(
      session.latestUserMessage,
      session.currentSql,
      nerPayload.normalizedTerms.join(' '),
      nerPayload.matchedMetrics.map((item) => `${item.term} ${item.metricName || ''} ${item.table} ${item.column}`).join(' '),
      planningHints.candidateTables.join(' '),
      planningHints.dimensions.join(' '),
      planningHints.metrics.join(' ')
    )
  );
  const schemaOverview = buildSchemaOverview(
    workspace.schema,
    workspace.metricMappings,
    keywords,
    workspace.runtimeConfig?.schemaOverviewTables || DEFAULT_SCHEMA_OVERVIEW_TABLE_LIMIT
  );
  const resultColumns = Array.isArray(session.currentResult?.columns)
    ? session.currentResult.columns.slice(0, limits.resultColumnCount)
    : [];
  const resultRows = Array.isArray(session.currentResult?.rows)
    ? session.currentResult.rows.slice(0, limits.resultRowCount)
    : [];

  return [
    '动态上下文如下：',
    `Workspace ID: ${workspace.workspaceId || '未提供'}`,
    `数据库实例 ID: ${workspace.databaseInstance.id}`,
    `数据库名称: ${workspace.databaseInstance.name}`,
    `数据库类型: ${workspace.databaseInstance.type}`,
    'Workspace 取数规则：',
    compactText(workspace.workspaceRules || '未设置额外规则。', limits.rules),
    'GEPA Prompt 策略：',
    compactText(workspace.runtimeConfig?.promptStrategy || '未启用额外 Prompt 策略。', Math.min(720, limits.planning)),
    `最近一次用户意图: ${compactText(session.latestUserMessage, 320)}`,
    `最近 5 条问题: ${compactJson(session.recentQuestions, limits.recentQuestions)}`,
    'Intent Agent 规划提示：',
    compactJson(planningHints, limits.planning),
    '当前 SQL 草稿：',
    compactText(session.currentSql, limits.currentSql),
    'Schema Agent 结果：',
    compactJson(nerPayload, limits.schema),
    '上一轮结果摘要：',
    compactText(session.currentResult?.summary, limits.resultSummary),
    '上一轮结果字段：',
    compactJson(resultColumns, limits.resultColumns),
    '上一轮结果样例：',
    compactJson(resultRows, limits.resultRows),
    '知识记忆摘要：',
    compactJson(buildKnowledgeOverview(workspace.knowledge, keywords), limits.knowledge),
    '轻量目录摘要：',
    compactJson(buildCatalogOverview(workspace.catalog, keywords), limits.catalog),
    '轻量语义摘要：',
    compactJson(buildSemanticOverview(workspace.semantic, keywords), limits.semantic),
    '高相关数据库表结构与指标摘要：',
    compactJson(schemaOverview, limits.schemaOverview),
  ].join('\n');
}

export function buildFallbackNerPayload(
  question: string,
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  preferredLimit?: number | null
): DBHarnessNerPayload {
  const keywords = buildKeywordSet(question);
  const candidates = buildNerCandidateBundle(schema, metricMappings, keywords, preferredLimit).candidates;

  return {
    normalizedTerms: Array.from(keywords).slice(0, 8),
    matchedMetrics: candidates
      .map((candidate) => ({
        term: candidate.metricName || candidate.column,
        table: candidate.table,
        column: candidate.column,
        metricName: candidate.metricName,
        confidence: 'medium' as const,
      }))
      .slice(0, 6),
    unmatchedTerms: [],
    timeHints: extractTimeRangeDays(question) ? [`近${extractTimeRangeDays(question)}天`] : [],
    intent: inferIntent(question),
  };
}

function selectTargetTable(
  workspace: DBHarnessWorkspaceContext,
  nerPayload: DBHarnessNerPayload,
  planningHints: DBHarnessPlanningHints,
  keywords: Set<string>
) {
  const matchedTable = nerPayload.matchedMetrics[0]?.table;
  if (matchedTable) {
    return workspace.schema.collections.find((collection) => collection.name === matchedTable) || null;
  }

  const hintedTable = planningHints.candidateTables.find((table) =>
    workspace.schema.collections.some((collection) => collection.name === table)
  );
  if (hintedTable) {
    return workspace.schema.collections.find((collection) => collection.name === hintedTable) || null;
  }

  const scored = workspace.schema.collections
    .filter((collection) => collection.category === 'table')
    .map((collection) => {
      const tableMetrics = workspace.metricMappings[collection.name];
      const score = scoreTextByKeywords(collection.name, keywords)
        + scoreTextByKeywords(tableMetrics?.description, keywords)
        + (collection.columns || []).reduce((sum, column) => {
          const metric = tableMetrics?.fields?.[column.name];
          return sum
            + scoreTextByKeywords(column.name, keywords)
            + scoreTextByKeywords(column.comment, keywords)
            + scoreTextByKeywords(metric?.metricName, keywords)
            + scoreTextByKeywords(metric?.description, keywords)
            + (metric?.aliases || []).reduce((aliasSum, alias) => aliasSum + scoreTextByKeywords(alias, keywords), 0);
        }, 0);
      return { collection, score };
    })
    .sort((left, right) => right.score - left.score || left.collection.name.localeCompare(right.collection.name));

  return scored[0] && scored[0].score > 0 ? scored[0].collection : null;
}

function hasMeaningfulFieldSignals(
  table: DatabaseSchemaPayload['collections'][number] | null,
  metricMappings: DatabaseMetricViewMap[string] | undefined,
  keywords: Set<string>,
  nerPayload: DBHarnessNerPayload
) {
  if (!table?.columns?.length) return false;
  if (nerPayload.matchedMetrics.some((item) => item.table === table.name)) return true;

  if (keywords.size === 0) return false;

  const tableScore = scoreTextByKeywords(table.name, keywords)
    + scoreTextByKeywords(metricMappings?.description, keywords);
  if (tableScore > 0) return true;

  return table.columns.some((column) => {
    const metric = metricMappings?.fields?.[column.name];
    return (
      scoreTextByKeywords(column.name, keywords) > 0
      || scoreTextByKeywords(column.comment, keywords) > 0
      || scoreTextByKeywords(metric?.metricName, keywords) > 0
      || scoreTextByKeywords(metric?.description, keywords) > 0
      || (metric?.aliases || []).some((alias) => scoreTextByKeywords(alias, keywords) > 0)
    );
  });
}

function determineLimit(question: string, preferred?: number | null): number {
  if (Number.isFinite(preferred) && preferred && preferred > 0) {
    return Math.min(Math.trunc(Number(preferred)), 200);
  }
  const limit = question.match(/(\d+)\s*条|top\s*(\d+)/i);
  const raw = limit?.[1] || limit?.[2];
  const value = Number.parseInt(raw || '20', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200) : 20;
}

function pickBestColumn(
  tableName: string,
  columns: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>,
  keywords: Set<string>,
  metricMappings: DatabaseMetricViewMap[string] | undefined,
  predicate: (column: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>[number]) => boolean
) {
  const scored = columns
    .filter(predicate)
    .map((column) => {
      const metric = metricMappings?.fields?.[column.name];
      const metricType = (metric?.metricType || '').toLowerCase();
      const calcMode = (metric?.calcMode || '').toLowerCase();
      const score = scoreTextByKeywords(column.name, keywords)
        + scoreTextByKeywords(column.comment, keywords)
        + scoreTextByKeywords(metric?.metricName, keywords)
        + scoreTextByKeywords(metric?.description, keywords)
        + (metric?.aliases || []).reduce((sum, alias) => sum + scoreTextByKeywords(alias, keywords), 0)
        + (metricType.includes('度量') || metricType.includes('metric') ? 2 : 0)
        + (metricType.includes('维度') || metricType.includes('dimension') ? 2 : 0)
        + (metricType.includes('时间') || metricType.includes('time') ? 2 : 0)
        + (metricType.includes('标识') || metricType.includes('id') ? 2 : 0)
        + (calcMode.includes('求和') || calcMode.includes('平均') || calcMode.includes('计数') ? 1 : 0);
      return { column, score, tableName };
    })
    .sort((left, right) => right.score - left.score || left.column.name.localeCompare(right.column.name));

  return scored[0]?.column;
}

function inferAggregateMode(
  question: string,
  planningHints: DBHarnessPlanningHints,
  metricColumn:
    | NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>[number]
    | undefined,
  tableMetricMappings: DatabaseMetricViewMap[string] | undefined
): QueryAggregate {
  const metricMapping = metricColumn ? tableMetricMappings?.fields?.[metricColumn.name] : undefined;
  const calcMode = (metricMapping?.calcMode || '').toLowerCase();
  const hinted = `${planningHints.metrics.join(' ')} ${planningHints.notes.join(' ')}`.toLowerCase();

  if (/数量|总数|几条|count/i.test(question) || calcMode.includes('count') || calcMode.includes('计数') || hinted.includes('count')) return 'count';
  if (/平均|avg/i.test(question) || calcMode.includes('平均') || hinted.includes('avg')) return 'avg';
  if (/总和|合计|汇总|sum/i.test(question) || calcMode.includes('求和') || hinted.includes('sum')) return 'sum';
  if (/最大|最高|max/i.test(question) || calcMode.includes('最大') || hinted.includes('max')) return 'max';
  if (/最小|最低|min/i.test(question) || calcMode.includes('最小') || hinted.includes('min')) return 'min';
  if (metricMapping?.metricType && /度量|metric/i.test(metricMapping.metricType)) return 'sum';
  return 'value';
}

function buildCompiledPlan(sql: string, values: unknown[] = []) {
  let previewSql = sql;
  values.forEach((value) => {
    previewSql = previewSql.replace(/\?/, quoteSqlLiteral(value));
  });
  return {
    text: sql,
    values,
    previewSql,
  };
}

function buildPlanFromResolvedSelection(input: {
  intent: string;
  strategy: 'llm' | 'rule';
  targetTable: string;
  summary: string;
  dimensions: DBHarnessQueryPlanDimension[];
  metrics: DBHarnessQueryPlanMetric[];
  filters: DBHarnessQueryPlanFilter[];
  orderBy: DBHarnessQueryPlan['orderBy'];
  limit: number;
  notes: string[];
  compiledSql: string;
  compiledValues?: unknown[];
}) : DBHarnessQueryPlan {
  return {
    intent: input.intent,
    strategy: input.strategy,
    targetTable: input.targetTable,
    summary: input.summary,
    dimensions: input.dimensions,
    metrics: input.metrics,
    filters: input.filters,
    orderBy: input.orderBy,
    limit: input.limit,
    notes: input.notes,
    compiled: buildCompiledPlan(input.compiledSql, input.compiledValues || []),
  };
}

export function buildFallbackQueryPlan(
  question: string,
  engine: 'mysql' | 'pgsql',
  workspace: DBHarnessWorkspaceContext,
  nerPayload: DBHarnessNerPayload,
  planningHints: DBHarnessPlanningHints
): DBHarnessQueryResult {
  const keywords = buildExpandedKeywordSet(
    workspace.schema,
    workspace.metricMappings,
    buildKeywordSet(
      question,
      planningHints.candidateTables.join(' '),
      planningHints.dimensions.join(' '),
      planningHints.metrics.join(' '),
      nerPayload.normalizedTerms.join(' '),
      nerPayload.matchedMetrics.map((item) => `${item.table} ${item.column} ${item.metricName || ''}`).join(' ')
    )
  );
  const table = selectTargetTable(workspace, nerPayload, planningHints, keywords);
  if (!table || !table.columns?.length) {
    throw new Error('当前问题没有匹配到对应的数据表，已中止 SQL 生成。请补充更明确的业务对象或表意图。');
  }

  const tableMetrics = workspace.metricMappings[table.name];
  if (!hasMeaningfulFieldSignals(table, tableMetrics, keywords, nerPayload)) {
    throw new Error(`当前问题没有在表 ${table.name} 中匹配到可用字段，已中止 SQL 生成。请明确指标、维度或时间条件后再试。`);
  }
  const dimensionColumn = pickBestColumn(
    table.name,
    table.columns,
    keywords,
    tableMetrics,
    (column) => isTextLikeType(column.type) || isDateLikeType(column.type)
  );
  const metricColumn = pickBestColumn(
    table.name,
    table.columns,
    keywords,
    tableMetrics,
    (column) => isNumericType(column.type)
  );
  const timeColumn = pickBestColumn(
    table.name,
    table.columns,
    keywords,
    tableMetrics,
    (column) => isDateLikeType(column.type) || /date|time|day|dt|created|updated/i.test(column.name)
  );
  if (!dimensionColumn && !metricColumn && !timeColumn && nerPayload.matchedMetrics.length === 0) {
    throw new Error(`当前问题没有在表 ${table.name} 中找到可映射的 SQL 字段，已中止当前流程。`);
  }
  const aggregateMode = inferAggregateMode(question, planningHints, metricColumn, tableMetrics);
  const timeRangeDays = planningHints.timeRangeDays || extractTimeRangeDays(question);
  const safeLimit = determineLimit(question, null);
  const tableSql = quoteIdentifier(engine, table.name);
  const filterStatements: string[] = [];
  const filters: DBHarnessQueryPlanFilter[] = [];

  if (timeColumn && timeRangeDays) {
    const quotedTime = quoteIdentifier(engine, timeColumn.name);
    filterStatements.push(
      engine === 'mysql'
        ? `${quotedTime} >= DATE_SUB(CURRENT_DATE, INTERVAL ${timeRangeDays} DAY)`
        : `${quotedTime} >= CURRENT_DATE - INTERVAL '${timeRangeDays} day'`
    );
    filters.push({
      table: table.name,
      column: timeColumn.name,
      label: tableMetrics?.fields?.[timeColumn.name]?.metricName || timeColumn.comment || timeColumn.name,
      operator: '>=',
      value: `CURRENT_DATE - ${timeRangeDays}d`,
      source: 'time-range',
    });
  }

  const whereClause = filterStatements.length > 0 ? `\nWHERE ${filterStatements.join(' AND ')}` : '';
  const dimensions: DBHarnessQueryPlanDimension[] = dimensionColumn
    ? [{
        table: table.name,
        column: dimensionColumn.name,
        label: tableMetrics?.fields?.[dimensionColumn.name]?.metricName || dimensionColumn.comment || dimensionColumn.name,
      }]
    : [];
  const metrics: DBHarnessQueryPlanMetric[] = metricColumn
    ? [{
        table: table.name,
        column: metricColumn.name,
        label: tableMetrics?.fields?.[metricColumn.name]?.metricName || metricColumn.comment || metricColumn.name,
        aggregate: aggregateMode,
      }]
    : aggregateMode === 'count'
      ? [{
          table: table.name,
          column: '*',
          label: '记录数',
          aggregate: 'count',
        }]
      : [];

  let message = `模型不可用，已回退到规则引擎并围绕 ${table.name} 生成可执行 SQL。`;
  let sql = '';
  let orderBy: DBHarnessQueryPlan['orderBy'] = [];

  if (aggregateMode === 'count') {
    if (dimensionColumn) {
      const quotedDimension = quoteIdentifier(engine, dimensionColumn.name);
      sql = `SELECT ${quotedDimension} AS dimension, COUNT(*) AS value\nFROM ${tableSql}${whereClause}\nGROUP BY ${quotedDimension}\nORDER BY value DESC\nLIMIT ${safeLimit};`;
      orderBy = [{ column: 'value', label: 'value', direction: 'desc' }];
      message = `已使用规则引擎按 ${dimensionColumn.name} 统计数量。`;
    } else {
      sql = `SELECT COUNT(*) AS value\nFROM ${tableSql}${whereClause}\nLIMIT 1;`;
    }
  } else if (aggregateMode !== 'value' && metricColumn) {
    const quotedMetric = quoteIdentifier(engine, metricColumn.name);
    const aggregateFn = aggregateMode.toUpperCase();
    if (dimensionColumn) {
      const quotedDimension = quoteIdentifier(engine, dimensionColumn.name);
      sql = `SELECT ${quotedDimension} AS dimension, ${aggregateFn}(${quotedMetric}) AS value\nFROM ${tableSql}${whereClause}\nGROUP BY ${quotedDimension}\nORDER BY value DESC\nLIMIT ${safeLimit};`;
      orderBy = [{ column: 'value', label: 'value', direction: 'desc' }];
      message = `已使用规则引擎按 ${dimensionColumn.name} 聚合 ${metricColumn.name}。`;
    } else {
      sql = `SELECT ${aggregateFn}(${quotedMetric}) AS value\nFROM ${tableSql}${whereClause}\nLIMIT 1;`;
      message = `已使用规则引擎聚合 ${metricColumn.name}。`;
    }
  } else {
    const selectedColumns = [
      timeColumn?.name,
      dimensionColumn?.name,
      metricColumn?.name,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .filter((value, index, list) => list.indexOf(value) === index)
      .slice(0, 4);
    const fallbackColumns = selectedColumns.length > 0
      ? selectedColumns
      : table.columns.slice(0, 4).map((column) => column.name);
    const selectClause = fallbackColumns.map((column) => quoteIdentifier(engine, column)).join(', ');
    const orderColumn = metricColumn?.name || timeColumn?.name || fallbackColumns[0];
    const orderClause = orderColumn
      ? `\nORDER BY ${quoteIdentifier(engine, orderColumn)} DESC`
      : '';
    sql = `SELECT ${selectClause}\nFROM ${tableSql}${whereClause}${orderClause}\nLIMIT ${safeLimit};`;
    orderBy = orderColumn ? [{ column: orderColumn, label: orderColumn, direction: 'desc' }] : [];
  }

  const normalizedSql = normalizeSqlForExecution(engine, sql);
  const plan = buildPlanFromResolvedSelection({
    intent: planningHints.intent || inferIntent(question),
    strategy: 'rule',
    targetTable: table.name,
    summary: message,
    dimensions,
    metrics,
    filters,
    orderBy,
    limit: safeLimit,
    notes: dedupeStrings([
      ...planningHints.notes,
      planningHints.candidateTables[0] ? `优先围绕 ${planningHints.candidateTables[0]}` : '',
      planningHints.metrics[0] ? `优先确认指标 ${planningHints.metrics[0]}` : '',
    ], 80).slice(0, 6),
    compiledSql: normalizedSql,
  });

  return {
    aiPayload: {
      message,
      sql: normalizedSql,
    },
    plan,
    detail: '模型规划不可用，已回退到规则引擎生成只读 SQL。',
    usedFallback: true,
  };
}

function sanitizePlanDimensions(input: unknown, fallback: DBHarnessQueryPlan['dimensions']) {
  if (!Array.isArray(input)) return fallback;
  const next = input
    .filter(isRecord)
    .reduce<DBHarnessQueryPlan['dimensions']>((list, item) => {
      const table = typeof item.table === 'string' ? item.table.trim() : '';
      const column = typeof item.column === 'string' ? item.column.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : column;
      if (!table || !column) return list;
      list.push({ table, column, label: label || column });
      return list;
    }, []);
  return next.length > 0 ? next.slice(0, 6) : fallback;
}

function sanitizePlanMetrics(input: unknown, fallback: DBHarnessQueryPlan['metrics']) {
  if (!Array.isArray(input)) return fallback;
  const next = input
    .filter(isRecord)
    .reduce<DBHarnessQueryPlan['metrics']>((list, item) => {
      const table = typeof item.table === 'string' ? item.table.trim() : '';
      const column = typeof item.column === 'string' ? item.column.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : column;
      const aggregate = normalizeAggregate(item.aggregate) || 'value';
      if (!table || !column) return list;
      list.push({ table, column, label: label || column, aggregate });
      return list;
    }, []);
  return next.length > 0 ? next.slice(0, 6) : fallback;
}

function sanitizePlanFilters(input: unknown, fallback: DBHarnessQueryPlan['filters']) {
  if (!Array.isArray(input)) return fallback;
  const next = input
    .filter(isRecord)
    .reduce<DBHarnessQueryPlan['filters']>((list, item) => {
      const table = typeof item.table === 'string' ? item.table.trim() : '';
      const column = typeof item.column === 'string' ? item.column.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : column;
      const operator = item.operator === '=' || item.operator === 'in' || item.operator === '>=' || item.operator === '<=' || item.operator === 'like'
        ? item.operator
        : '=';
      const source = typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'llm';
      const value = item.value;
      if (!table || !column) return list;
      if (
        typeof value !== 'string'
        && typeof value !== 'number'
        && typeof value !== 'boolean'
        && !(Array.isArray(value) && value.every((child) => typeof child === 'string' || typeof child === 'number'))
      ) {
        return list;
      }
      list.push({ table, column, label: label || column, operator, value, source });
      return list;
    }, []);
  return next.length > 0 ? next.slice(0, 8) : fallback;
}

function sanitizePlanOrderBy(input: unknown, fallback: DBHarnessQueryPlan['orderBy']) {
  if (!Array.isArray(input)) return fallback;
  const next = input
    .filter(isRecord)
    .reduce<DBHarnessQueryPlan['orderBy']>((list, item) => {
      const column = typeof item.column === 'string' ? item.column.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : column;
      const direction = item.direction === 'asc' ? 'asc' : 'desc';
      if (!column) return list;
      list.push({ column, label: label || column, direction });
      return list;
    }, []);
  return next.length > 0 ? next.slice(0, 4) : fallback;
}

export function parseSchemaAgentPayload(rawContent: string): DBHarnessNerPayload {
  return sanitizeNerPayload(parseJsonSafely(rawContent));
}

export function parseQueryAgentPayload(
  rawContent: string,
  engine: 'mysql' | 'pgsql',
  fallback: DBHarnessQueryPlan
) {
  const parsed = parseJsonSafely(rawContent);
  const aiPayload = sanitizeAiPayload(parsed, engine);
  const source = isRecord(parsed) ? parsed : {};
  const planSource = isRecord(source.plan) ? source.plan : {};
  const limit = determineLimit('', Number.parseInt(String(planSource.limit ?? ''), 10) || fallback.limit);
  const normalizedSql = normalizeSqlForExecution(engine, aiPayload.sql);

  return {
    aiPayload: {
      ...aiPayload,
      sql: normalizedSql,
    },
    plan: {
      intent: typeof planSource.intent === 'string' && planSource.intent.trim() ? planSource.intent.trim() : fallback.intent,
      strategy: 'llm' as const,
      targetTable: typeof planSource.targetTable === 'string' && planSource.targetTable.trim()
        ? planSource.targetTable.trim()
        : fallback.targetTable,
      summary: typeof planSource.summary === 'string' && planSource.summary.trim()
        ? planSource.summary.trim()
        : aiPayload.message,
      dimensions: sanitizePlanDimensions(planSource.dimensions, fallback.dimensions),
      metrics: sanitizePlanMetrics(planSource.metrics, fallback.metrics),
      filters: sanitizePlanFilters(planSource.filters, fallback.filters),
      orderBy: sanitizePlanOrderBy(planSource.orderBy, fallback.orderBy),
      limit,
      notes: dedupeStrings([
        ...(Array.isArray(planSource.notes) ? planSource.notes.filter((item): item is string => typeof item === 'string') : []),
        ...fallback.notes,
      ], 80).slice(0, 6),
      compiled: buildCompiledPlan(normalizedSql),
    },
  };
}

export function buildPlaceholderQueryPlan(
  question: string,
  engine: 'mysql' | 'pgsql',
  intent?: string
): DBHarnessQueryPlan {
  const normalizedSql = normalizeSqlForExecution(engine, 'SELECT 1 AS placeholder LIMIT 1;');
  return {
    intent: intent || inferIntent(question),
    strategy: 'rule',
    targetTable: undefined,
    summary: '尚未从当前问题中收敛到可执行字段，等待模型或规则继续规划。',
    dimensions: [],
    metrics: [],
    filters: [],
    orderBy: [],
    limit: 1,
    notes: ['当前为占位查询计划，不应进入执行阶段。'],
    compiled: buildCompiledPlan(normalizedSql),
  };
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAIModelHeaders, buildAiChatEndpoint } from '@/lib/ai-models';
import { getEffectiveDatabaseMetricMappings } from '@/lib/database-instances';
import { executeDbApi } from '@/lib/db-api';
import { getAIModelProfileById, getDatabaseInstanceById } from '@/lib/db';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { normalizeSqlForExecution } from '@/lib/sql-normalize';
import { normalizeMongoQueryText } from '@/lib/mongo-query-compat';
import { AIModelProfile, DatabaseSchemaPayload, DbApiConfig } from '@/lib/types';
import { createPendingTrace, HarnessTraceRole, HarnessTraceStep, HarnessTurnResponse } from './harness-types';

type ChatRole = 'user' | 'assistant';

export interface Nl2DataChatMessage {
  role: ChatRole;
  content: string;
}

export interface Nl2DataSelectedModelInput {
  profileId: string;
  modelId: string;
}

export interface Nl2DataAgentRequest {
  messages: Nl2DataChatMessage[];
  selectedModel?: Nl2DataSelectedModelInput | null;
  databaseInstanceId?: string;
  currentSql?: string;
  currentResult?: {
    columns?: string[];
    rows?: Record<string, unknown>[];
    summary?: string;
  } | null;
}

export interface Nl2DataExecutionPayload {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  summary?: string;
  datasource: string;
  engine: 'mysql' | 'pgsql' | 'mongo';
  previewSql: string;
}

export interface Nl2DataAgentResult {
  message: string;
  sql: string;
  execution?: Nl2DataExecutionPayload;
  prompt: string;
}

interface DatabaseFieldMetricView {
  metricName?: string;
  description?: string;
  metricType?: string;
  calcMode?: string;
  enableForNer?: boolean;
  aliases?: string[];
}

interface DatabaseTableMetricView {
  description?: string;
  fields: Record<string, DatabaseFieldMetricView>;
}

type DatabaseMetricViewMap = Record<string, DatabaseTableMetricView>;

interface Nl2DataAiPayload {
  message: string;
  sql: string;
}

interface Nl2DataNerCandidate {
  table: string;
  column: string;
  metricName?: string;
  description?: string;
  aliases: string[];
}

interface Nl2DataMatchedMetric {
  term: string;
  table: string;
  column: string;
  metricName?: string;
  confidence: 'high' | 'medium' | 'low';
}

interface Nl2DataNerPayload {
  normalizedTerms: string[];
  matchedMetrics: Nl2DataMatchedMetric[];
  unmatchedTerms: string[];
  timeHints: string[];
  intent: string;
}

interface HarnessAnalysisResult {
  reply: string;
  summary: string;
  followUps: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonSafely(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function compactJson(value: unknown, maxLength = 20000): string {
  const text = JSON.stringify(value);
  if (!text) return 'null';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

function compactText(value: string | null | undefined, maxLength = 2400): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(empty)';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function dedupeStrings(values: Array<string | null | undefined>, maxLength = 60): string[] {
  const seen = new Set<string>();
  const next: string[] = [];

  values.forEach((value) => {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const normalized = text.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    next.push(text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`);
  });

  return next;
}

function extractJsonPayload(content: string): string {
  const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(start, end + 1);
  }

  throw new Error('AI 未返回可解析的 JSON 内容');
}

function getModelErrorMessage(upstreamJson: unknown): string {
  return isRecord(upstreamJson) && isRecord(upstreamJson.error) && typeof upstreamJson.error.message === 'string'
    ? upstreamJson.error.message
    : '模型请求失败';
}

function extractConnectionErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }

  if (error instanceof AggregateError) {
    for (const item of error.errors) {
      const nestedCode = extractConnectionErrorCode(item);
      if (nestedCode) return nestedCode;
    }
  }

  return null;
}

export function getNl2DataErrorMessage(error: unknown): string {
  const connectionCode = extractConnectionErrorCode(error);
  if (connectionCode === 'ECONNREFUSED') {
    return '数据库连接失败，请确认当前数据源服务已启动，并检查连接地址、端口、用户名与密码是否可用。';
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'NL2DATA 执行失败';
}

function buildKeywordSet(...values: Array<string | null | undefined>): Set<string> {
  const keywords = new Set<string>();

  values.forEach((value) => {
    const matches = (value || '').toLowerCase().match(/[\p{Script=Han}a-z0-9_]+/gu) || [];
    matches
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .forEach((item) => keywords.add(item));
  });

  return keywords;
}

function truncateText(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function scoreTextByKeywords(value: string | undefined, keywords: Set<string>): number {
  if (!value || keywords.size === 0) return 0;
  const normalized = value.toLowerCase();
  let score = 0;
  keywords.forEach((keyword) => {
    if (normalized.includes(keyword)) {
      score += keyword.length >= 4 ? 4 : 2;
    }
  });
  return score;
}

function buildSchemaOverview(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  keywords: Set<string>
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
    .slice(0, 8)
    .map((item) => item.payload);

  return {
    engine: schema.engine,
    tableCount: schema.collections.filter((item) => item.category === 'table').length,
    focusTables: tables,
  };
}

function sanitizeAiPayload(input: unknown, databaseEngine: 'mysql' | 'pgsql' | 'mongo'): Nl2DataAiPayload {
  const source = isRecord(input) ? input : {};
  const sql = typeof source.sql === 'string' ? source.sql.trim() : '';

  if (!sql) {
    throw new Error('AI 没有返回可用的 SQL');
  }

  return {
    message: typeof source.message === 'string' && source.message.trim()
      ? source.message.trim()
      : '已根据你的描述生成查询 SQL。',
    sql: normalizeSqlForExecution(
      databaseEngine,
      databaseEngine === 'mongo' ? normalizeMongoQueryText(sql) : sql
    ),
  };
}

function scoreCandidate(candidate: Nl2DataNerCandidate, keywords: Set<string>): number {
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

function buildNerCandidateBundle(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  keywords: Set<string>
): {
  totalAvailable: number;
  candidateCount: number;
  truncated: boolean;
  candidates: Nl2DataNerCandidate[];
} {
  const allCandidates: Nl2DataNerCandidate[] = [];

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
          description: truncateText(metric.description || column.comment || tableMetrics?.description, 20),
          aliases: dedupeStrings([
            ...(metric.aliases || []),
            metric.metricName,
            column.name,
            collection.name,
          ], 18).slice(0, 3),
        });
      });
    });

  const sorted = allCandidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, keywords),
    }))
    .sort((left, right) => right.score - left.score
      || left.candidate.table.localeCompare(right.candidate.table)
      || left.candidate.column.localeCompare(right.candidate.column));

  const hardLimit = 16;
  const matched = keywords.size > 0 ? sorted.filter((item) => item.score > 0) : sorted;
  const chosen = (matched.length > 0 ? matched : sorted).slice(0, hardLimit).map((item) => item.candidate);

  return {
    totalAvailable: allCandidates.length,
    candidateCount: chosen.length,
    truncated: allCandidates.length > chosen.length,
    candidates: chosen,
  };
}

function sanitizeNerPayload(input: unknown): Nl2DataNerPayload {
  const source = isRecord(input) ? input : {};
  const sanitizeTextList = (value: unknown, max = 12) => (
    Array.isArray(value)
      ? dedupeStrings(value.map((item) => (typeof item === 'string' ? item : '')), 40).slice(0, max)
      : []
  );

  const matchedMetrics = Array.isArray(source.matchedMetrics)
    ? source.matchedMetrics
      .filter(isRecord)
      .reduce<Nl2DataMatchedMetric[]>((list, item) => {
        const confidence = item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low'
          ? item.confidence
          : 'medium';
        const term = typeof item.term === 'string' ? item.term.trim() : '';
        const table = typeof item.table === 'string' ? item.table.trim() : '';
        const column = typeof item.column === 'string' ? item.column.trim() : '';
        const metricName = typeof item.metricName === 'string' ? item.metricName.trim() : undefined;
        if (!term || !table || !column) {
          return list;
        }
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

function inferHarnessIntent(question: string): string {
  const text = question.toLowerCase();
  if (/对比|同比|环比|compare/.test(text)) return 'comparison';
  if (/趋势|变化|trend/.test(text)) return 'analysis';
  if (/诊断|原因/.test(text)) return 'diagnosis';
  if (/图|chart|可视化/.test(text)) return 'visualization';
  return 'query';
}

function cloneTrace(trace: HarnessTraceStep[]): HarnessTraceStep[] {
  return trace.map((step) => ({ ...step }));
}

function updateTrace(
  trace: HarnessTraceStep[],
  role: HarnessTraceRole,
  status: HarnessTraceStep['status'],
  detail: string
) {
  const target = trace.find((step) => step.role === role);
  if (!target) return;
  target.status = status;
  target.detail = detail;
}

function failTraceFrom(trace: HarnessTraceStep[], role: HarnessTraceRole, detail: string) {
  let afterFailure = false;
  trace.forEach((step) => {
    if (step.role === role) {
      step.status = 'failed';
      step.detail = detail;
      afterFailure = true;
      return;
    }
    if (afterFailure && step.status === 'pending') {
      step.detail = '由于上一步失败，本步骤未开始。';
    }
  });
}

function buildFailureResponse(
  trace: HarnessTraceStep[],
  role: HarnessTraceRole,
  detail: string,
  sql?: string
): HarnessTurnResponse {
  failTraceFrom(trace, role, detail);
  return {
    outcome: 'error',
    reply: detail,
    trace: cloneTrace(trace),
    artifacts: sql
      ? {
          sql,
          summary: '当前回合已中断，没有生成可用的数据结果。',
        }
      : undefined,
    followUps: [],
  };
}

function assertHarnessGuardrails(
  sql: string
) {
  const normalized = sql.trim();
  if (/(--|\/\*)/.test(normalized)) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：SQL 不能包含注释。');
  }

  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(normalized)) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：SQL 包含危险关键字。');
  }
}

function buildSchemaDetail(
  nerPayload: Nl2DataNerPayload,
  candidates: ReturnType<typeof buildNerCandidateBundle>
): string {
  const matchedTables = Array.from(new Set(nerPayload.matchedMetrics.map((item) => item.table))).slice(0, 3);
  if (matchedTables.length > 0) {
    return `已围绕 ${matchedTables.join('、')} 汇总候选表结构，并确认 ${nerPayload.matchedMetrics.length} 个字段映射。`;
  }

  return `已检索 ${candidates.candidateCount} 个高相关 NER 候选实体，当前以规则和语义摘要共同支撑后续规划。`;
}

function summarizeTopValues(row: Record<string, unknown> | undefined, columns: string[]): string {
  if (!row || columns.length === 0) return '';
  return columns
    .slice(0, 3)
    .map((column) => `${column}=${compactText(String(row[column] ?? '—'), 24)}`)
    .join('，');
}

function buildAnalysisResult(
  question: string,
  aiMessage: string,
  execution: Nl2DataExecutionPayload
): HarnessAnalysisResult {
  if (execution.rows.length === 0) {
    return {
      reply: '已经完成一轮 harness 取数，但当前条件下没有命中数据。你可以放宽时间范围、减少筛选条件，或者换一个维度继续追问。',
      summary: execution.summary || '查询执行成功，但当前条件下没有返回数据。',
      followUps: [
        '把时间范围放宽到最近 30 天',
        '减少筛选条件，只看总体趋势',
        '换一个分组维度继续查询',
      ],
    };
  }

  const topValues = summarizeTopValues(execution.rows[0], execution.columns);
  const numericColumns = execution.columns.filter((column) =>
    execution.rows.some((row) => typeof row[column] === 'number')
  );
  const textColumns = execution.columns.filter((column) =>
    execution.rows.some((row) => typeof row[column] === 'string')
  );

  const followUps = new Set<string>();
  if (textColumns.length > 0) {
    followUps.add(`按 ${textColumns[0]} 继续分组`);
  }
  if (numericColumns.length > 0) {
    followUps.add(`对 ${numericColumns[0]} 补充汇总分析`);
  }
  if (/近\s*7\s*天|最近\s*7\s*天/.test(question) === false) {
    followUps.add('只看最近 7 天的数据');
  }
  if (followUps.size < 3) {
    followUps.add('补充同比或环比视角');
  }

  return {
    reply: `${aiMessage} 当前返回 ${execution.rows.length} 行结果${topValues ? `，首行关键信息为 ${topValues}` : ''}。`,
    summary: execution.summary || `已返回 ${execution.rows.length} 行结果，可继续基于当前 SQL 追问。`,
    followUps: Array.from(followUps).slice(0, 3),
  };
}

function isLikelyModelUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const errorName = error instanceof Error ? error.name.toLowerCase() : '';
  return (
    errorName === 'timeouterror'
    || errorName === 'aborterror'
    || message.includes('超时')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('aborted due to timeout')
    || message.includes('operation was aborted')
    || message.includes('fetch failed')
    || message.includes('econnrefused')
    || message.includes('模型请求失败')
  );
}

function isNumericType(type: string): boolean {
  return /int|decimal|numeric|float|double|real|serial|number|bigint|smallint/i.test(type);
}

function isDateLikeType(type: string): boolean {
  return /date|time|timestamp|datetime/i.test(type);
}

function isTextLikeType(type: string): boolean {
  return /char|text|json|uuid|enum|set/i.test(type);
}

function quoteHarnessIdentifier(engine: 'mysql' | 'pgsql', name: string): string {
  const parts = name.split('.');
  return parts.map((part) => (engine === 'mysql' ? `\`${part}\`` : `"${part}"`)).join('.');
}

function extractTimeRangeDays(question: string): number | null {
  const match = question.match(/近\s*(\d+)\s*天|最近\s*(\d+)\s*天/i);
  const raw = match?.[1] || match?.[2];
  if (!raw) return null;
  const next = Number.parseInt(raw, 10);
  return Number.isFinite(next) && next > 0 ? next : null;
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

function buildFallbackNerPayload(
  question: string,
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap
): Nl2DataNerPayload {
  const keywords = buildKeywordSet(question);
  const candidates = buildNerCandidateBundle(schema, metricMappings, keywords).candidates;

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
    intent: inferHarnessIntent(question),
  };
}

function pickFallbackTable(
  question: string,
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  nerPayload: Nl2DataNerPayload
) {
  const keywords = buildKeywordSet(question, nerPayload.normalizedTerms.join(' '));
  const matchedTable = nerPayload.matchedMetrics[0]?.table;
  if (matchedTable) {
    return schema.collections.find((collection) => collection.name === matchedTable) || null;
  }

  const scored = schema.collections
    .filter((collection) => collection.category === 'table')
    .map((collection) => {
      const tableMetrics = metricMappings[collection.name];
      const score = scoreTextByKeywords(collection.name, keywords)
        + scoreTextByKeywords(tableMetrics?.description, keywords)
        + (collection.columns || []).reduce((sum, column) => {
          const metric = tableMetrics?.fields?.[column.name];
          return sum
            + scoreTextByKeywords(column.name, keywords)
            + scoreTextByKeywords(column.comment, keywords)
            + scoreTextByKeywords(metric?.metricName, keywords)
            + (metric?.aliases || []).reduce((aliasSum, alias) => aliasSum + scoreTextByKeywords(alias, keywords), 0);
        }, 0);
      return { collection, score };
    })
    .sort((left, right) => right.score - left.score || left.collection.name.localeCompare(right.collection.name));

  return scored[0]?.collection || null;
}

function pickBestColumn(
  columns: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>,
  keywords: Set<string>,
  metricMappings: DatabaseMetricViewMap[string] | undefined,
  predicate: (column: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>[number]) => boolean
) {
  const scored = columns
    .filter(predicate)
    .map((column) => {
      const metric = metricMappings?.fields?.[column.name];
      const score = scoreTextByKeywords(column.name, keywords)
        + scoreTextByKeywords(column.comment, keywords)
        + scoreTextByKeywords(metric?.metricName, keywords)
        + scoreTextByKeywords(metric?.description, keywords)
        + (metric?.aliases || []).reduce((sum, alias) => sum + scoreTextByKeywords(alias, keywords), 0);
      return { column, score };
    })
    .sort((left, right) => right.score - left.score || left.column.name.localeCompare(right.column.name));

  return scored[0]?.column;
}

function filterMongoProjectionColumns(columns: string[]) {
  const next: string[] = [];
  columns.forEach((column) => {
    const normalized = column.trim();
    if (!normalized) return;
    const hasAncestor = next.some((existing) => normalized.startsWith(`${existing}.`));
    if (hasAncestor) return;
    const hasDescendant = next.some((existing) => existing.startsWith(`${normalized}.`));
    if (hasDescendant) {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].startsWith(`${normalized}.`)) {
          next.splice(index, 1);
        }
      }
    }
    if (!next.includes(normalized)) {
      next.push(normalized);
    }
  });
  return next;
}

function buildFallbackSqlPayload(
  question: string,
  engine: 'mysql' | 'pgsql' | 'mongo',
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  nerPayload: Nl2DataNerPayload
): Nl2DataAiPayload {
  const table = pickFallbackTable(question, schema, metricMappings, nerPayload);
  if (!table || !table.columns?.length) {
    throw new Error('规则引擎未能找到可用于生成 SQL 的表结构。');
  }

  const keywords = buildKeywordSet(
    question,
    nerPayload.normalizedTerms.join(' '),
    nerPayload.matchedMetrics.map((item) => `${item.table} ${item.column} ${item.metricName || ''}`).join(' ')
  );
  const tableMetrics = metricMappings[table.name];

  if (engine === 'mongo') {
    const dimensionColumn = pickBestColumn(
      table.columns,
      keywords,
      tableMetrics,
      (column) => isTextLikeType(column.type) || isDateLikeType(column.type)
    );
    const metricColumn = pickBestColumn(
      table.columns,
      keywords,
      tableMetrics,
      (column) => isNumericType(column.type)
    );
    const timeColumn = pickBestColumn(
      table.columns,
      keywords,
      tableMetrics,
      (column) => isDateLikeType(column.type) || /date|time|day|dt|created|updated/i.test(column.name)
    );
    const aggregateMode = /平均|avg/i.test(question)
      ? 'avg'
      : /总和|合计|汇总|sum/i.test(question)
        ? 'sum'
        : /最大|最高|max/i.test(question)
          ? 'max'
          : /最小|最低|min/i.test(question)
            ? 'min'
            : /数量|总数|几条|count/i.test(question)
              ? 'count'
              : 'value';
    const timeRangeDays = extractTimeRangeDays(question);
    const limit = determineLimit(question, null);
    const command: Record<string, unknown> = {
      collection: table.name,
      limit,
      filter: {},
    };

    if (timeColumn && timeRangeDays) {
      command.filter = {
        [timeColumn.name]: { $gte: new Date(Date.now() - timeRangeDays * 24 * 60 * 60 * 1000) },
      };
    }

    if (aggregateMode === 'count') {
      command.operation = 'count';
      if (dimensionColumn) {
        command.operation = 'aggregate';
        command.pipeline = [
          { $match: command.filter },
          { $group: { _id: `$${dimensionColumn.name}`, value: { $sum: 1 } } },
          { $project: { _id: 0, dimension: '$_id', value: 1 } },
          { $sort: { value: -1 } },
          { $limit: limit },
        ];
      }
    } else if (aggregateMode !== 'value' && metricColumn) {
      command.operation = 'aggregate';
      const aggregateExpr = aggregateMode === 'sum'
        ? { $sum: `$${metricColumn.name}` }
        : aggregateMode === 'avg'
          ? { $avg: `$${metricColumn.name}` }
          : aggregateMode === 'max'
            ? { $max: `$${metricColumn.name}` }
            : { $min: `$${metricColumn.name}` };
      if (dimensionColumn) {
        command.pipeline = [
          { $match: command.filter },
          { $group: { _id: `$${dimensionColumn.name}`, value: aggregateExpr } },
          { $project: { _id: 0, dimension: '$_id', value: 1 } },
          { $sort: { value: -1 } },
          { $limit: limit },
        ];
      } else {
        command.pipeline = [
          { $match: command.filter },
          { $group: { _id: null, value: aggregateExpr } },
          { $project: { _id: 0, value: 1 } },
          { $limit: 1 },
        ];
      }
    } else {
      command.operation = 'find';
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
      const projectionColumns = filterMongoProjectionColumns(fallbackColumns);
      command.projection = projectionColumns.reduce<Record<string, unknown>>((accumulator, column) => {
        accumulator[column] = 1;
        return accumulator;
      }, { _id: 1 });
      command.sort = {
        [metricColumn?.name || timeColumn?.name || projectionColumns[0]]: -1,
      };
    }

    const sql = JSON.stringify(command, null, 2);
    return {
      message: `已使用规则引擎围绕 ${table.name} 生成只读 Mongo 查询命令。`,
      sql,
    };
  }

  const aggregateMode = /平均|avg/i.test(question)
    ? 'avg'
    : /总和|合计|汇总|sum/i.test(question)
      ? 'sum'
      : /最大|最高|max/i.test(question)
        ? 'max'
        : /最小|最低|min/i.test(question)
          ? 'min'
          : /数量|总数|几条|count/i.test(question)
            ? 'count'
            : 'value';

  const dimensionColumn = pickBestColumn(
    table.columns,
    keywords,
    tableMetrics,
    (column) => isTextLikeType(column.type) || isDateLikeType(column.type)
  );
  const metricColumn = pickBestColumn(
    table.columns,
    keywords,
    tableMetrics,
    (column) => isNumericType(column.type)
  );
  const timeColumn = pickBestColumn(
    table.columns,
    keywords,
    tableMetrics,
    (column) => isDateLikeType(column.type) || /date|time|day|dt|created|updated/i.test(column.name)
  );
  const timeRangeDays = extractTimeRangeDays(question);
  const tableSql = quoteHarnessIdentifier(engine, table.name);
  const filters: string[] = [];

  if (timeColumn && timeRangeDays) {
    const quotedTime = quoteHarnessIdentifier(engine, timeColumn.name);
    filters.push(
      engine === 'mysql'
        ? `${quotedTime} >= DATE_SUB(CURRENT_DATE, INTERVAL ${timeRangeDays} DAY)`
        : `${quotedTime} >= CURRENT_DATE - INTERVAL '${timeRangeDays} day'`
    );
  }

  const whereClause = filters.length > 0 ? `\nWHERE ${filters.join(' AND ')}` : '';
  const limit = question.match(/(\d+)\s*条|top\s*(\d+)/i);
  const limitValue = Number.parseInt(limit?.[1] || limit?.[2] || '20', 10);
  const safeLimit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 200) : 20;

  if (aggregateMode === 'count') {
    if (dimensionColumn) {
      const quotedDimension = quoteHarnessIdentifier(engine, dimensionColumn.name);
      return {
        message: `已使用规则引擎按 ${dimensionColumn.name} 统计数量。`,
        sql: `SELECT ${quotedDimension} AS dimension, COUNT(*) AS value\nFROM ${tableSql}${whereClause}\nGROUP BY ${quotedDimension}\nORDER BY value DESC\nLIMIT ${safeLimit};`,
      };
    }

    return {
      message: '已使用规则引擎统计总数。',
      sql: `SELECT COUNT(*) AS value\nFROM ${tableSql}${whereClause}\nLIMIT 1;`,
    };
  }

  if (aggregateMode !== 'value' && metricColumn) {
    const quotedMetric = quoteHarnessIdentifier(engine, metricColumn.name);
    const aggregateFn = aggregateMode.toUpperCase();
    if (dimensionColumn) {
      const quotedDimension = quoteHarnessIdentifier(engine, dimensionColumn.name);
      return {
        message: `已使用规则引擎按 ${dimensionColumn.name} 聚合 ${metricColumn.name}。`,
        sql: `SELECT ${quotedDimension} AS dimension, ${aggregateFn}(${quotedMetric}) AS value\nFROM ${tableSql}${whereClause}\nGROUP BY ${quotedDimension}\nORDER BY value DESC\nLIMIT ${safeLimit};`,
      };
    }

    return {
      message: `已使用规则引擎聚合 ${metricColumn.name}。`,
      sql: `SELECT ${aggregateFn}(${quotedMetric}) AS value\nFROM ${tableSql}${whereClause}\nLIMIT 1;`,
    };
  }

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
  const projectionColumns = filterMongoProjectionColumns(fallbackColumns);

  const selectClause = projectionColumns
    .map((column) => quoteHarnessIdentifier(engine, column))
    .join(', ');

  const orderColumn = metricColumn?.name || timeColumn?.name || projectionColumns[0];
  const orderClause = orderColumn
    ? `\nORDER BY ${quoteHarnessIdentifier(engine, orderColumn)} DESC`
    : '';

  return {
    message: `模型不可用，已回退到规则引擎并围绕 ${table.name} 生成可执行 SQL。`,
    sql: `SELECT ${selectClause}\nFROM ${tableSql}${whereClause}${orderClause}\nLIMIT ${safeLimit};`,
  };
}
const promptTemplateCache = new Map<string, string>();

async function loadPromptTemplate(filename: string): Promise<string> {
  const cached = promptTemplateCache.get(filename);
  if (cached) return cached;
  const promptPath = path.join(process.cwd(), 'src/prompts', filename);
  const template = await readFile(promptPath, 'utf8');
  promptTemplateCache.set(filename, template);
  return template;
}

function renderPromptTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((result, [key, value]) => (
    result.replaceAll(`{{${key}}}`, value)
  ), template);
}

function buildNerPromptContext(
  databaseInstanceId: string,
  databaseName: string,
  databaseEngine: 'mysql' | 'pgsql' | 'mongo',
  question: string,
  currentSql: string,
  candidates: ReturnType<typeof buildNerCandidateBundle>
): string {
  return [
    '动态上下文如下：',
    `数据库实例 ID: ${databaseInstanceId}`,
    `数据库名称: ${databaseName}`,
    `数据库类型: ${databaseEngine}`,
    `用户原始问句: ${compactText(question, 320)}`,
    '当前 SQL 草稿：',
    compactText(currentSql, 1200),
    '第一轮 NER 候选实体：',
    compactJson(candidates, 3200),
  ].join('\n');
}

function buildSqlPromptContext(
  databaseInstanceId: string,
  databaseName: string,
  databaseEngine: 'mysql' | 'pgsql' | 'mongo',
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  currentSql: string,
  messages: Nl2DataChatMessage[],
  nerPayload: Nl2DataNerPayload,
  currentResult?: Nl2DataAgentRequest['currentResult']
): string {
  const latestUserMessage = messages.filter((message) => message.role === 'user').at(-1)?.content || '';
  const keywords = buildKeywordSet(
    latestUserMessage,
    currentSql,
    nerPayload.normalizedTerms.join(' '),
    nerPayload.matchedMetrics.map((item) => `${item.term} ${item.metricName || ''} ${item.table} ${item.column}`).join(' ')
  );
  const schemaOverview = buildSchemaOverview(schema, metricMappings, keywords);
  const resultColumns = Array.isArray(currentResult?.columns) ? currentResult?.columns.slice(0, 24) : [];
  const resultRows = Array.isArray(currentResult?.rows) ? currentResult.rows.slice(0, 3) : [];

  return [
    '动态上下文如下：',
    `数据库实例 ID: ${databaseInstanceId}`,
    `数据库名称: ${databaseName}`,
    `数据库类型: ${databaseEngine}`,
    `最近一次用户意图: ${compactText(latestUserMessage, 320)}`,
    '当前 SQL 草稿：',
    compactText(currentSql, 2400),
    '第一轮 NER 结果：',
    compactJson(nerPayload, 3200),
    '上一轮结果摘要：',
    compactText(currentResult?.summary, 400),
    '上一轮结果字段：',
    compactJson(resultColumns, 1200),
    '上一轮结果样例：',
    compactJson(resultRows, 2400),
    '高相关数据库表结构与指标摘要：',
    compactJson(schemaOverview, 8000),
  ].join('\n');
}

function buildUpstreamPayload(systemPrompt: string, messages: Nl2DataChatMessage[], modelId: string) {
  return {
    model: modelId,
    temperature: 0.2,
    stream: false,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };
}

async function requestModelContent(
  endpoint: string,
  profile: AIModelProfile,
  modelId: string,
  systemPrompt: string,
  messages: Nl2DataChatMessage[]
): Promise<string> {
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(endpoint, {
      method: 'POST',
      headers: buildAIModelHeaders(profile),
      body: JSON.stringify(buildUpstreamPayload(systemPrompt, messages, modelId)),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.name === 'TimeoutError'
        || error.name === 'AbortError'
        || error.message.toLowerCase().includes('aborted due to timeout')
        || error.message.toLowerCase().includes('operation was aborted')
      )
    ) {
      throw new Error('模型请求超时，请稍后重试或切换到响应更快的模型。');
    }
    throw error;
  }

  const upstreamText = await upstreamResponse.text();
  const upstreamJson = parseJsonSafely(upstreamText);

  if (!upstreamResponse.ok) {
    throw new Error(getModelErrorMessage(upstreamJson));
  }

  return isRecord(upstreamJson)
    && Array.isArray(upstreamJson.choices)
    && upstreamJson.choices.length > 0
    && isRecord(upstreamJson.choices[0])
    && isRecord(upstreamJson.choices[0].message)
    && typeof upstreamJson.choices[0].message.content === 'string'
    ? upstreamJson.choices[0].message.content
    : '';
}

function createExecutorDbApiConfig(sql: string, databaseInstanceId: string): DbApiConfig {
  return {
    id: 'nl2data-executor',
    name: 'NL2DATA Executor',
    apiGroup: '系统内置',
    description: 'Transient NL2DATA execution config',
    method: 'POST',
    path: '/nl2data/runtime',
    customParams: [],
    databaseInstanceId,
    sqlTemplate: sql,
    paramBindings: [],
    redisConfig: { enabled: false },
    createdAt: '',
    updatedAt: '',
  };
}

export async function runNl2DataExecutor(input: Nl2DataAgentRequest): Promise<Nl2DataAgentResult> {
  const selectedModel = input.selectedModel;
  if (!selectedModel?.profileId || !selectedModel?.modelId) {
    throw new Error('请先在模型管理中配置并选择可用模型。');
  }

  if (!input.databaseInstanceId) {
    throw new Error('请先选择数据源。');
  }

  const databaseInstance = getDatabaseInstanceById(input.databaseInstanceId);
  if (!databaseInstance) {
    throw new Error('当前数据源不存在，请重新选择。');
  }

  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql' && databaseInstance.type !== 'mongo') {
    throw new Error('NL2DATA 暂时仅支持 MySQL、PostgreSQL 和 MongoDB 数据源。');
  }

  const profile = getAIModelProfileById(selectedModel.profileId);
  if (!profile) {
    throw new Error('当前模型配置不存在，请重新选择模型。');
  }

  if (!profile.modelIds.includes(selectedModel.modelId)) {
    throw new Error('当前模型来源未包含所选 Model ID。');
  }

  const endpoint = buildAiChatEndpoint(profile.baseUrl);
  if (!endpoint) {
    throw new Error('当前模型的 Base URL 无效。');
  }

  const schema = await getDatabaseSchema(databaseInstance);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: databaseInstance.metricMappings,
    semanticModel: databaseInstance.semanticModel,
  }) as DatabaseMetricViewMap;
  const latestUserMessage = input.messages.filter((message) => message.role === 'user').at(-1)?.content || '';
  const keywords = buildKeywordSet(latestUserMessage, input.currentSql || '');
  const nerCandidates = buildNerCandidateBundle(schema, metricMappings, keywords);
  const nerPromptTemplate = await loadPromptTemplate('nl2data-ner.md');
  const nerPrompt = renderPromptTemplate(nerPromptTemplate, {
    DYNAMIC_CONTEXT: buildNerPromptContext(
      databaseInstance.id,
      databaseInstance.name,
      databaseInstance.type,
      latestUserMessage,
      input.currentSql || '',
      nerCandidates
    ),
  });

  const nerContent = await requestModelContent(
    endpoint,
    profile,
    selectedModel.modelId,
    nerPrompt,
    [{ role: 'user', content: latestUserMessage }]
  );
  const nerPayload = sanitizeNerPayload(parseJsonSafely(extractJsonPayload(nerContent)));

  const promptTemplate = await loadPromptTemplate('nl2data-agent.md');
  const prompt = renderPromptTemplate(promptTemplate, {
    DYNAMIC_CONTEXT: buildSqlPromptContext(
      databaseInstance.id,
      databaseInstance.name,
      databaseInstance.type,
      schema,
      metricMappings,
      input.currentSql || '',
      input.messages,
      nerPayload,
      input.currentResult
    ),
  });
  const content = await requestModelContent(
    endpoint,
    profile,
    selectedModel.modelId,
    prompt,
    input.messages
  );

  const aiPayload = sanitizeAiPayload(
    parseJsonSafely(extractJsonPayload(content)),
    databaseInstance.type
  );

  const execution = await executeDbApi(
    createExecutorDbApiConfig(aiPayload.sql, databaseInstance.id),
    databaseInstance,
    {},
    { previewLimit: 200 }
  );

  return {
    message: aiPayload.message,
    sql: aiPayload.sql,
    execution: {
      sql: aiPayload.sql,
      columns: execution.result.columns,
      rows: execution.result.rows,
      summary: execution.result.summary,
      datasource: databaseInstance.name,
      engine: databaseInstance.type,
      previewSql: execution.debug.previewSql,
    },
    prompt: [
      '[NER Prompt]',
      nerPrompt,
      '',
      '[NER Result]',
      JSON.stringify(nerPayload, null, 2),
      '',
      '[SQL Prompt]',
      prompt,
    ].join('\n'),
  };
}

export async function executeNl2DataSql(
  databaseInstanceId: string,
  sql: string
): Promise<Nl2DataExecutionPayload> {
  if (!databaseInstanceId) {
    throw new Error('请先选择数据源。');
  }

  const databaseInstance = getDatabaseInstanceById(databaseInstanceId);
  if (!databaseInstance) {
    throw new Error('当前数据源不存在，请重新选择。');
  }

  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql' && databaseInstance.type !== 'mongo') {
    throw new Error('NL2DATA 暂时仅支持 MySQL、PostgreSQL 和 MongoDB 数据源。');
  }

  assertHarnessGuardrails(sql);

  const execution = await executeDbApi(
    createExecutorDbApiConfig(sql, databaseInstance.id),
    databaseInstance,
    {},
    { previewLimit: 200 }
  );

  return {
    sql,
    columns: execution.result.columns,
    rows: execution.result.rows,
    summary: execution.result.summary,
    datasource: databaseInstance.name,
    engine: databaseInstance.type,
    previewSql: execution.debug.previewSql,
  };
}

export async function runNl2DataHarnessExecutor(input: Nl2DataAgentRequest): Promise<HarnessTurnResponse> {
  const selectedModel = input.selectedModel;
  if (!selectedModel?.profileId || !selectedModel?.modelId) {
    throw new Error('请先在模型管理中配置并选择可用模型。');
  }

  if (!input.databaseInstanceId) {
    throw new Error('请先选择数据源。');
  }

  const latestUserMessage = input.messages.filter((message) => message.role === 'user').at(-1)?.content?.trim() || '';
  if (!latestUserMessage) {
    throw new Error('请输入自然语言问题。');
  }

  const databaseInstance = getDatabaseInstanceById(input.databaseInstanceId);
  if (!databaseInstance) {
    throw new Error('当前数据源不存在，请重新选择。');
  }

  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql' && databaseInstance.type !== 'mongo') {
    throw new Error('DB Harness 暂时仅支持 MySQL、PostgreSQL 和 MongoDB 数据源。');
  }

  const profile = getAIModelProfileById(selectedModel.profileId);
  if (!profile) {
    throw new Error('当前模型配置不存在，请重新选择模型。');
  }

  if (!profile.modelIds.includes(selectedModel.modelId)) {
    throw new Error('当前模型来源未包含所选 Model ID。');
  }

  const endpoint = buildAiChatEndpoint(profile.baseUrl);
  if (!endpoint) {
    throw new Error('当前模型的 Base URL 无效。');
  }

  const trace = createPendingTrace();
  const inferredIntent = inferHarnessIntent(latestUserMessage);
  updateTrace(
    trace,
    'intent',
    'completed',
    `已结合当前问句与选中数据源，确认本轮意图为 ${inferredIntent}，并继续在 ${databaseInstance.name} 上规划取数。`
  );

  const schema: DatabaseSchemaPayload = await getDatabaseSchema(databaseInstance);
  const metricMappings: DatabaseMetricViewMap = getEffectiveDatabaseMetricMappings({
    metricMappings: databaseInstance.metricMappings,
    semanticModel: databaseInstance.semanticModel,
  }) as DatabaseMetricViewMap;
  let nerPayload: Nl2DataNerPayload;
  let aiPayload: Nl2DataAiPayload;

  try {
    const keywords = buildKeywordSet(latestUserMessage, input.currentSql || '');
    const nerCandidates = buildNerCandidateBundle(schema, metricMappings, keywords);
    const nerPromptTemplate = await loadPromptTemplate('nl2data-ner.md');
    const nerPrompt = renderPromptTemplate(nerPromptTemplate, {
      DYNAMIC_CONTEXT: buildNerPromptContext(
        databaseInstance.id,
        databaseInstance.name,
        databaseInstance.type,
        latestUserMessage,
        input.currentSql || '',
        nerCandidates
      ),
    });

    const nerContent = await requestModelContent(
      endpoint,
      profile,
      selectedModel.modelId,
      nerPrompt,
      [{ role: 'user', content: latestUserMessage }]
    );
    nerPayload = sanitizeNerPayload(parseJsonSafely(extractJsonPayload(nerContent)));

    updateTrace(trace, 'schema', 'completed', buildSchemaDetail(nerPayload, nerCandidates));
  } catch (error) {
    if (isLikelyModelUnavailable(error)) {
      nerPayload = buildFallbackNerPayload(latestUserMessage, schema, metricMappings);
      updateTrace(trace, 'schema', 'completed', '模型规划不可用，已回退到规则引擎完成字段语义识别与候选实体选择。');
    } else {
      return buildFailureResponse(
        trace,
        'schema',
        error instanceof Error ? error.message : 'Schema Agent 执行失败。'
      );
    }
  }

  try {
    const promptTemplate = await loadPromptTemplate('nl2data-agent.md');
    const prompt = renderPromptTemplate(promptTemplate, {
      DYNAMIC_CONTEXT: buildSqlPromptContext(
        databaseInstance.id,
        databaseInstance.name,
        databaseInstance.type,
        schema,
        metricMappings,
        input.currentSql || '',
        input.messages,
        nerPayload,
        input.currentResult
      ),
    });

    const content = await requestModelContent(
      endpoint,
      profile,
      selectedModel.modelId,
      prompt,
      input.messages
    );

    aiPayload = sanitizeAiPayload(
      parseJsonSafely(extractJsonPayload(content)),
      databaseInstance.type
    );

    updateTrace(
      trace,
      'query',
      'completed',
      `已基于 ${selectedModel.modelId} 生成只读 SQL，并围绕当前语义映射补齐排序、聚合和结果限制。`
    );
  } catch (error) {
    if (isLikelyModelUnavailable(error)) {
      aiPayload = buildFallbackSqlPayload(
        latestUserMessage,
        databaseInstance.type,
        schema,
        metricMappings,
        nerPayload
      );
      updateTrace(trace, 'query', 'completed', '模型规划不可用，已回退到规则引擎生成只读 SQL。');
    } else {
      return buildFailureResponse(
        trace,
        'query',
        error instanceof Error ? error.message : 'Query Agent 执行失败。'
      );
    }
  }

  let execution: Nl2DataExecutionPayload;
  try {
    assertHarnessGuardrails(aiPayload.sql);
    const rawExecution = await executeDbApi(
      createExecutorDbApiConfig(aiPayload.sql, databaseInstance.id),
      databaseInstance,
      {},
      { previewLimit: 200 }
    );

    execution = {
      sql: aiPayload.sql,
      columns: rawExecution.result.columns,
      rows: rawExecution.result.rows,
      summary: rawExecution.result.summary,
      datasource: databaseInstance.name,
      engine: databaseInstance.type,
      previewSql: rawExecution.debug.previewSql,
    };

    updateTrace(
      trace,
      'guardrail',
      'completed',
      `已通过只读执行网关校验，并返回 ${execution.rows.length} 行预览结果。`
    );
  } catch (error) {
    return buildFailureResponse(
      trace,
      'guardrail',
      error instanceof Error ? error.message : 'Guardrail Agent 执行失败。',
      aiPayload.sql
    );
  }

  try {
    const analysis = buildAnalysisResult(latestUserMessage, aiPayload.message, execution);
    updateTrace(
      trace,
      'analysis',
      'completed',
      execution.rows.length === 0
        ? '结果为空，已生成收缩条件与替代追问建议。'
        : '已基于当前结果生成摘要与下一步追问建议。'
    );

    return {
      outcome: execution.rows.length === 0 ? 'empty' : 'success',
      reply: analysis.reply,
      trace: cloneTrace(trace),
      artifacts: {
        sql: execution.sql,
        summary: analysis.summary,
        columns: execution.columns,
        previewRows: execution.rows.slice(0, 12),
        previewSql: execution.previewSql,
      },
      followUps: analysis.followUps,
    };
  } catch (error) {
    return buildFailureResponse(
      trace,
      'analysis',
      error instanceof Error ? error.message : 'Analysis Agent 执行失败。',
      execution.sql
    );
  }
}

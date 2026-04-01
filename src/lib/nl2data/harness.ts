import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAIModelHeaders, buildAiChatEndpoint } from '@/lib/ai-models';
import { sanitizeDatabaseMetricMappings } from '@/lib/database-instances';
import { executeDbApi } from '@/lib/db-api';
import { getAIModelProfileById, getDatabaseInstanceById } from '@/lib/db';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { normalizeSqlForExecution } from '@/lib/sql-normalize';
import { DatabaseSchemaPayload, DbApiConfig } from '@/lib/types';

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
  engine: 'mysql' | 'pgsql';
  previewSql: string;
}

export interface Nl2DataAgentResult {
  message: string;
  sql: string;
  execution: Nl2DataExecutionPayload;
  prompt: string;
}

interface DatabaseFieldMetricView {
  metricName?: string;
  description?: string;
  metricType?: string;
  calcMode?: string;
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

function sanitizeAiPayload(input: unknown, databaseEngine: 'mysql' | 'pgsql'): Nl2DataAiPayload {
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

let promptTemplateCache: string | null = null;

async function loadPromptTemplate(): Promise<string> {
  if (promptTemplateCache) return promptTemplateCache;
  const promptPath = path.join(process.cwd(), 'src/prompts/nl2data-agent.md');
  promptTemplateCache = await readFile(promptPath, 'utf8');
  return promptTemplateCache;
}

function renderPromptTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((result, [key, value]) => (
    result.replaceAll(`{{${key}}}`, value)
  ), template);
}

function buildPromptContext(
  databaseInstanceId: string,
  databaseName: string,
  databaseEngine: 'mysql' | 'pgsql',
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  currentSql: string,
  messages: Nl2DataChatMessage[],
  currentResult?: Nl2DataAgentRequest['currentResult']
): string {
  const latestUserMessage = messages.filter((message) => message.role === 'user').at(-1)?.content || '';
  const keywords = buildKeywordSet(latestUserMessage, currentSql);
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

function createHarnessDbApiConfig(sql: string, databaseInstanceId: string): DbApiConfig {
  return {
    id: 'nl2data-harness',
    name: 'NL2DATA Harness',
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

export async function runNl2DataHarness(input: Nl2DataAgentRequest): Promise<Nl2DataAgentResult> {
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

  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql') {
    throw new Error('NL2DATA 暂时仅支持 MySQL 和 PostgreSQL 数据源。');
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
  const metricMappings = sanitizeDatabaseMetricMappings(databaseInstance.metricMappings || {}) as DatabaseMetricViewMap;
  const promptTemplate = await loadPromptTemplate();
  const prompt = renderPromptTemplate(promptTemplate, {
    DYNAMIC_CONTEXT: buildPromptContext(
      databaseInstance.id,
      databaseInstance.name,
      databaseInstance.type,
      schema,
      metricMappings,
      input.currentSql || '',
      input.messages,
      input.currentResult
    ),
  });

  const upstreamResponse = await fetch(endpoint, {
    method: 'POST',
    headers: buildAIModelHeaders(profile),
    body: JSON.stringify(buildUpstreamPayload(prompt, input.messages, selectedModel.modelId)),
  });

  const upstreamText = await upstreamResponse.text();
  const upstreamJson = parseJsonSafely(upstreamText);

  if (!upstreamResponse.ok) {
    throw new Error(getModelErrorMessage(upstreamJson));
  }

  const content = isRecord(upstreamJson)
    && Array.isArray(upstreamJson.choices)
    && upstreamJson.choices.length > 0
    && isRecord(upstreamJson.choices[0])
    && isRecord(upstreamJson.choices[0].message)
    && typeof upstreamJson.choices[0].message.content === 'string'
    ? upstreamJson.choices[0].message.content
    : '';

  const aiPayload = sanitizeAiPayload(
    parseJsonSafely(extractJsonPayload(content)),
    databaseInstance.type
  );

  const execution = await executeDbApi(
    createHarnessDbApiConfig(aiPayload.sql, databaseInstance.id),
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
    prompt,
  };
}

export async function executeNl2DataSql(databaseInstanceId: string, sql: string): Promise<Nl2DataExecutionPayload> {
  if (!databaseInstanceId) {
    throw new Error('请先选择数据源。');
  }

  const databaseInstance = getDatabaseInstanceById(databaseInstanceId);
  if (!databaseInstance) {
    throw new Error('当前数据源不存在，请重新选择。');
  }

  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql') {
    throw new Error('NL2DATA 暂时仅支持 MySQL 和 PostgreSQL 数据源。');
  }

  const execution = await executeDbApi(
    createHarnessDbApiConfig(sql, databaseInstance.id),
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

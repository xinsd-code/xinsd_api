import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { buildAIModelHeaders, buildAiChatEndpoint } from '@/lib/ai-models';
import { getAIModelProfileById } from '@/lib/db';
import { normalizeSqlForExecution } from '@/lib/sql-normalize';
import { CustomParamDef, DatabaseSchemaPayload } from '@/lib/types';

export const runtime = 'nodejs';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface SelectedModelInput {
  profileId: string;
  modelId: string;
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

interface DbApiAiChatRequestBody {
  messages: ChatMessage[];
  selectedModel?: SelectedModelInput;
  databaseInstanceId?: string;
  databaseEngine?: string;
  schema?: DatabaseSchemaPayload | null;
  metricMappings?: DatabaseMetricViewMap;
  currentSql?: string;
  customParams?: CustomParamDef[];
  promptOverride?: string;
  stream?: boolean;
}

interface SanitizedSqlPayload {
  message: string;
  sql: string;
  variables: string[];
  prompt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactJson(value: unknown, maxLength = 24000): string {
  const text = JSON.stringify(value);
  if (!text) return 'null';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

function compactText(value: string | null | undefined, maxLength = 4000): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(empty)';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function parseJsonSafely(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

function sanitizeVariables(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function sanitizeSqlPayload(
  input: unknown,
  databaseEngine?: string | null
): SanitizedSqlPayload {
  const source = isRecord(input) ? input : {};
  const sql = typeof source.sql === 'string' ? source.sql.trim() : '';

  if (!sql) {
    throw new Error('AI 没有返回可用的 SQL');
  }

  const normalizedSql = databaseEngine === 'mysql' || databaseEngine === 'pgsql'
    ? normalizeSqlForExecution(databaseEngine, sql)
    : sql;

  return {
    message: typeof source.message === 'string' && source.message.trim()
      ? source.message.trim()
      : 'SQL 已生成。',
    sql: normalizedSql,
    variables: sanitizeVariables(source.variables),
  };
}

function validateSelectedModel(input: unknown): SelectedModelInput | null {
  if (!isRecord(input)) return null;
  if (typeof input.profileId !== 'string' || typeof input.modelId !== 'string') {
    return null;
  }

  const profileId = input.profileId.trim();
  const modelId = input.modelId.trim();
  if (!profileId || !modelId) return null;

  return { profileId, modelId };
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

function summarizeCustomParams(params: CustomParamDef[]): Array<Record<string, unknown>> {
  return params.map((param) => ({
    key: param.key,
    type: param.type,
    description: truncateText(param.description, 80) || undefined,
    defaultValue: truncateText(param.defaultValue, 40) || undefined,
  }));
}

function buildSchemaOverview(
  schema: DatabaseSchemaPayload | null | undefined,
  metricMappings: DatabaseMetricViewMap,
  keywords: Set<string>
): unknown {
  const tables = (schema?.collections || [])
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
              metricName: truncateText(metric?.metricName, 40) || undefined,
              metricDesc: truncateText(metric?.description, 70) || undefined,
              metricType: truncateText(metric?.metricType, 30) || undefined,
              calcMode: truncateText(metric?.calcMode, 30) || undefined,
            },
          };
        })
        .sort((left, right) => right.score - left.score || left.payload.name.localeCompare(right.payload.name))
        .slice(0, 8)
        .map((item) => item.payload);

      return {
        score: tableScore,
        payload: {
          table: collection.name,
          desc: truncateText(tableMetrics?.description, 80) || undefined,
          columns,
        },
      };
    })
    .sort((left, right) => right.score - left.score || left.payload.table.localeCompare(right.payload.table))
    .slice(0, 6)
    .map((item) => item.payload);

  return {
    engine: schema?.engine || null,
    tableCount: schema?.collections?.filter((item) => item.category === 'table').length || 0,
    focusTables: tables,
  };
}

let promptTemplateCache: string | null = null;

async function loadPromptTemplate(): Promise<string> {
  if (promptTemplateCache) return promptTemplateCache;
  const promptPath = path.join(process.cwd(), 'src/prompts/db-api-ai-chat.md');
  promptTemplateCache = await readFile(promptPath, 'utf8');
  return promptTemplateCache;
}

function renderPromptTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((result, [key, value]) => (
    result.replaceAll(`{{${key}}}`, value)
  ), template);
}

function buildPromptContext(body: DbApiAiChatRequestBody): string {
  const customParams = Array.isArray(body.customParams) ? body.customParams : [];
  const metricMappings = isRecord(body.metricMappings) ? body.metricMappings as DatabaseMetricViewMap : {};
  const latestUserMessage = body.messages.filter((message) => message.role === 'user').at(-1)?.content || '';
  const keywords = buildKeywordSet(latestUserMessage, body.currentSql, customParams.map((item) => item.key).join(' '));
  const schemaOverview = buildSchemaOverview(body.schema || null, metricMappings, keywords);

  return [
    '动态上下文如下：',
    `数据库实例 ID: ${body.databaseInstanceId || 'unknown'}`,
    `数据库类型: ${body.databaseEngine || body.schema?.engine || 'unknown'}`,
    `最近一次用户意图: ${compactText(latestUserMessage, 320)}`,
    '当前 SQL 草稿：',
    compactText(body.currentSql, 2400),
    '当前 API 自定义入参：',
    compactJson(summarizeCustomParams(customParams), 2400),
    '高相关数据库表结构与指标摘要：',
    compactJson(schemaOverview, 7200),
  ].join('\n');
}

function buildUpstreamPayload(body: DbApiAiChatRequestBody, systemPrompt: string, stream: boolean, modelId: string) {
  return {
    model: modelId,
    temperature: 0.2,
    stream,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...body.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };
}

function getModelErrorMessage(upstreamJson: unknown): string {
  return isRecord(upstreamJson) && isRecord(upstreamJson.error) && typeof upstreamJson.error.message === 'string'
    ? upstreamJson.error.message
    : '模型请求失败';
}

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as DbApiAiChatRequestBody;
    const selectedModel = validateSelectedModel(body.selectedModel);
    if (!selectedModel) {
      return NextResponse.json({ error: '请先在模型管理中配置并选择可用模型。' }, { status: 400 });
    }

    const profile = getAIModelProfileById(selectedModel.profileId);
    if (!profile) {
      return NextResponse.json({ error: '当前模型配置不存在，请重新选择模型。' }, { status: 400 });
    }

    if (!profile.modelIds.includes(selectedModel.modelId)) {
      return NextResponse.json({ error: '当前模型来源未包含所选 Model ID。' }, { status: 400 });
    }

    const endpoint = buildAiChatEndpoint(profile.baseUrl);
    if (!endpoint) {
      return NextResponse.json({ error: '当前模型的 Base URL 无效。' }, { status: 400 });
    }

    if (profile.authType === 'bearer' && !profile.authToken) {
      return NextResponse.json({ error: '当前模型缺少 Bearer Token。' }, { status: 400 });
    }

    if (profile.authType === 'custom-header' && (!profile.authHeaderName || !profile.authToken)) {
      return NextResponse.json({ error: '当前模型缺少自定义鉴权配置。' }, { status: 400 });
    }

    const promptTemplate = await loadPromptTemplate();
    const systemPrompt = renderPromptTemplate(promptTemplate, {
      DYNAMIC_CONTEXT: buildPromptContext(body),
    });
    const effectivePrompt = body.promptOverride?.trim() || systemPrompt;
    const stream = body.stream === true;

    const upstreamResponse = await fetch(endpoint, {
      method: 'POST',
      headers: buildAIModelHeaders(profile),
      body: JSON.stringify(buildUpstreamPayload(body, effectivePrompt, stream, selectedModel.modelId)),
    });

    if (stream) {
      if (!upstreamResponse.ok) {
        const upstreamText = await upstreamResponse.text();
        return NextResponse.json(
          { error: getModelErrorMessage(parseJsonSafely(upstreamText)) },
          { status: upstreamResponse.status }
        );
      }

      if (!upstreamResponse.body) {
        return NextResponse.json({ error: 'AI 流式响应不可用' }, { status: 500 });
      }

      const upstreamBody = upstreamResponse.body;
      const streamResponse = new ReadableStream<Uint8Array>({
        async start(controller) {
          const decoder = new TextDecoder();
          const reader = upstreamBody.getReader();
          let buffer = '';
          let accumulatedContent = '';

          const flushEvent = (rawEvent: string) => {
            const lines = rawEvent
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            const dataLines = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim());

            if (dataLines.length === 0) return;

            for (const payload of dataLines) {
              if (!payload || payload === '[DONE]') continue;

              const parsed = JSON.parse(payload) as Record<string, unknown>;
              const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
              const delta = isRecord(choice) && isRecord(choice.delta) && typeof choice.delta.content === 'string'
                ? choice.delta.content
                : '';

              if (delta) {
                accumulatedContent += delta;
                controller.enqueue(encodeSseEvent('delta', { content: delta }));
              }
            }
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value) continue;

              buffer += decoder.decode(value, { stream: true });
              let boundaryIndex = buffer.indexOf('\n\n');
              while (boundaryIndex !== -1) {
                const rawEvent = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);
                flushEvent(rawEvent);
                boundaryIndex = buffer.indexOf('\n\n');
              }
            }

            if (buffer.trim()) {
              flushEvent(buffer);
            }

            const parsed = sanitizeSqlPayload(
              parseJsonSafely(extractJsonPayload(accumulatedContent)),
              body.databaseEngine || body.schema?.engine
            );
            controller.enqueue(encodeSseEvent('done', { ...parsed, prompt: effectivePrompt }));
          } catch (error) {
            controller.enqueue(
              encodeSseEvent('error', {
                error: error instanceof Error ? error.message : 'AI 流式响应处理失败',
              })
            );
          } finally {
            reader.releaseLock();
            controller.close();
          }
        },
      });

      return new Response(streamResponse, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    const upstreamText = await upstreamResponse.text();
    const upstreamJson = parseJsonSafely(upstreamText);

    if (!upstreamResponse.ok) {
      return NextResponse.json({ error: getModelErrorMessage(upstreamJson) }, { status: upstreamResponse.status });
    }

    const content = isRecord(upstreamJson)
      && Array.isArray(upstreamJson.choices)
      && upstreamJson.choices.length > 0
      && isRecord(upstreamJson.choices[0])
      && isRecord(upstreamJson.choices[0].message)
      && typeof upstreamJson.choices[0].message.content === 'string'
      ? upstreamJson.choices[0].message.content
      : '';

    return NextResponse.json({
      ...sanitizeSqlPayload(
        parseJsonSafely(extractJsonPayload(content)),
        body.databaseEngine || body.schema?.engine
      ),
      prompt: effectivePrompt,
    });
  } catch (error) {
    console.error('Failed to generate DB API SQL with AI:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AI SQL 生成失败' },
      { status: 500 }
    );
  }
}

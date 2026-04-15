import { NextResponse } from 'next/server';
import { getAIModelProfileById, getDatabaseInstanceById, updateDatabaseInstanceSemanticModel } from '@/lib/db';
import { buildAIModelEndpoint, buildAIModelHeaders } from '@/lib/ai-models';
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import { getDatabaseCollectionPreview, getDatabaseSchema } from '@/lib/database-instances-server';
import { deriveSemanticSnapshot } from '@/lib/db-harness/tools/catalog-tools';
import {
  DatabaseCollectionInfo,
  DatabaseSemanticModel,
  DatabaseSemanticModelEntity,
  DatabaseSemanticModelField,
  DatabaseSemanticRole,
  DatabaseSchemaPayload,
  AIModelSelection,
} from '@/lib/types';
import { compactJson, isDateLikeType, isNumericType, isRecord, isTextLikeType, parseJsonSafely } from '@/lib/db-harness/core/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SemanticGenerationRequestBody {
  persist?: boolean;
  collection?: string;
  selectedModel?: Pick<AIModelSelection, 'profileId' | 'modelId'> | null;
}

function inferSemanticRole(
  column: NonNullable<DatabaseCollectionInfo['columns']>[number]
): DatabaseSemanticRole {
  const name = column.name.toLowerCase();
  if (isDateLikeType(column.type) || /date|time|day|dt|created|updated/i.test(name)) {
    return 'time';
  }
  if (column.isPrimary || /(^id$|_id$|uuid|code$)/i.test(name)) {
    return 'identifier';
  }
  if (isNumericType(column.type)) {
    return 'metric';
  }
  if (isTextLikeType(column.type)) {
    return 'dimension';
  }
  return 'attribute';
}

function normalizeTextList(values: string[], limit: number): string[] {
  return values
    .map((item) => item.trim())
    .filter((item, index, array) => item.length > 0 && array.indexOf(item) === index)
    .slice(0, limit);
}

function buildDefaultSemanticEntity(
  table: string,
  schema: DatabaseSchemaPayload,
  metricMappings: ReturnType<typeof getEffectiveDatabaseMetricMappings>,
  baseEntity?: DatabaseSemanticModelEntity | null
): DatabaseSemanticModelEntity {
  const collection = schema.collections.find((item) => item.name === table);
  const fieldMap = new Map((baseEntity?.fields || []).map((field) => [field.column, field]));
  const tableMetrics = metricMappings[table];
  const fields = (collection?.columns || []).map((column) => {
    const existing = fieldMap.get(column.name);
    if (existing) {
      return { ...existing, aliases: [...(existing.aliases || [])] };
    }

    const metric = tableMetrics?.fields?.[column.name];
    return {
      table,
      column: column.name,
      metricName: metric?.metricName || column.comment?.trim() || column.name,
      description: metric?.description || column.comment?.trim() || '',
      metricType: metric?.metricType,
      calcMode: metric?.calcMode,
      enableForNer: metric?.enableForNer === true,
      aliases: [...(metric?.aliases || [])],
      semanticRole: inferSemanticRole(column),
      derivedFrom: metric ? 'mapping' : 'schema',
    } satisfies DatabaseSemanticModelField;
  });

  return {
    table,
    description: baseEntity?.description || tableMetrics?.description || '',
    metrics: [],
    dimensions: [],
    timeFields: [],
    identifierFields: [],
    nerEnabledFields: [],
    fields,
  };
}

function buildDefaultSemanticModel(schema: DatabaseSchemaPayload, metricMappings: ReturnType<typeof getEffectiveDatabaseMetricMappings>): DatabaseSemanticModel {
  return deriveSemanticSnapshot(schema, metricMappings);
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const content = fenced?.[1]?.trim() || trimmed;
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  const normalized = firstBrace >= 0 && lastBrace > firstBrace
    ? content.slice(firstBrace, lastBrace + 1)
    : content;
  return parseJsonSafely(normalized);
}

function normalizeGeneratedEntity(
  value: unknown,
  table: string,
  schema: DatabaseSchemaPayload,
  metricMappings: ReturnType<typeof getEffectiveDatabaseMetricMappings>,
  baseEntity?: DatabaseSemanticModelEntity | null
): DatabaseSemanticModelEntity {
  const fallback = buildDefaultSemanticEntity(table, schema, metricMappings, baseEntity);
  if (!isRecord(value)) return fallback;

  const candidate = Array.isArray(value.entities)
    ? value.entities.find((item) => isRecord(item) && typeof item.table === 'string' && item.table.trim() === table)
    : value;
  if (!isRecord(candidate)) return fallback;

  const candidateFields = Array.isArray(candidate.fields) ? candidate.fields : [];
  const fieldMap = new Map(fallback.fields.map((field) => [field.column, field]));

  candidateFields.forEach((field) => {
    if (!isRecord(field) || typeof field.column !== 'string') return;
    const column = field.column.trim();
    if (!column) return;
    const existing = fieldMap.get(column);
    const tableColumn = schema.collections
      .find((item) => item.name === table)
      ?.columns?.find((item) => item.name === column);
    const metric = metricMappings[table]?.fields?.[column];
    const nextField: DatabaseSemanticModelField = {
      table,
      column,
      metricName: typeof field.metricName === 'string' && field.metricName.trim()
        ? field.metricName.trim()
        : existing?.metricName || metric?.metricName || tableColumn?.comment?.trim() || column,
      description: typeof field.description === 'string' ? field.description.trim() : existing?.description || metric?.description || tableColumn?.comment?.trim() || '',
      metricType: typeof field.metricType === 'string' && field.metricType.trim()
        ? field.metricType.trim()
        : existing?.metricType || metric?.metricType || '',
      calcMode: typeof field.calcMode === 'string' && field.calcMode.trim()
        ? field.calcMode.trim()
        : existing?.calcMode || metric?.calcMode || '',
      enableForNer: field.enableForNer === true || existing?.enableForNer === true || metric?.enableForNer === true,
      aliases: normalizeTextList(Array.isArray(field.aliases)
        ? field.aliases.map((item) => (typeof item === 'string' ? item : ''))
        : existing?.aliases || metric?.aliases || [], 12),
      semanticRole: typeof field.semanticRole === 'string'
        ? (field.semanticRole as DatabaseSemanticRole)
        : existing?.semanticRole || inferSemanticRole(tableColumn || { name: column, type: '', nullable: true } as NonNullable<DatabaseCollectionInfo['columns']>[number]),
      derivedFrom: 'manual',
    };
    fieldMap.set(column, nextField);
  });

  const fields = schema.collections
    .find((item) => item.name === table)
    ?.columns?.map((column) => fieldMap.get(column.name) || fallback.fields.find((field) => field.column === column.name) || {
      table,
      column: column.name,
      metricName: column.comment?.trim() || column.name,
      description: column.comment?.trim() || '',
      enableForNer: false,
      aliases: [],
      semanticRole: inferSemanticRole(column),
      derivedFrom: 'schema',
    } satisfies DatabaseSemanticModelField)
    .filter((item): item is DatabaseSemanticModelField => Boolean(item)) || fallback.fields;

  return {
    table,
    description: typeof candidate.description === 'string' && candidate.description.trim()
      ? candidate.description.trim()
      : fallback.description || '',
    metrics: normalizeTextList(Array.isArray(candidate.metrics) ? candidate.metrics : fields.filter((field) => field.semanticRole === 'metric').map((field) => field.metricName), 12),
    dimensions: normalizeTextList(Array.isArray(candidate.dimensions) ? candidate.dimensions : fields.filter((field) => field.semanticRole === 'dimension').map((field) => field.metricName), 12),
    timeFields: normalizeTextList(Array.isArray(candidate.timeFields) ? candidate.timeFields : fields.filter((field) => field.semanticRole === 'time').map((field) => field.metricName), 8),
    identifierFields: normalizeTextList(Array.isArray(candidate.identifierFields) ? candidate.identifierFields : fields.filter((field) => field.semanticRole === 'identifier').map((field) => field.metricName), 8),
    nerEnabledFields: normalizeTextList(Array.isArray(candidate.nerEnabledFields) ? candidate.nerEnabledFields : fields.filter((field) => field.enableForNer).map((field) => field.metricName), 16),
    fields: fields.map((field) => ({
      ...field,
      aliases: normalizeTextList(field.aliases || [], 12),
      derivedFrom: 'manual',
    })),
  };
}

async function requestAiSemanticModel(
  schema: DatabaseSchemaPayload,
  metricMappings: ReturnType<typeof getEffectiveDatabaseMetricMappings>,
  table: DatabaseCollectionInfo,
  previewRows: Record<string, unknown>[],
  selectedModel: Pick<AIModelSelection, 'profileId' | 'modelId'>
): Promise<{ entity: DatabaseSemanticModelEntity; modelLabel: string }> {
  const profile = getAIModelProfileById(selectedModel.profileId);
  if (!profile) {
    throw new Error('所选模型配置不存在');
  }
  if (profile.modelType !== 'chat') {
    throw new Error('语义自动生成仅支持对话模型');
  }
  if (!profile.modelIds.includes(selectedModel.modelId)) {
    throw new Error('所选 Model ID 不属于当前模型配置');
  }

  const endpoint = buildAIModelEndpoint(profile.baseUrl, profile.modelType);
  if (!endpoint) {
    throw new Error('所选模型 Base URL 无效');
  }

  const fallbackEntity = buildDefaultSemanticEntity(table.name, schema, metricMappings);
  const prompt = [
    '你是一名数据库语义建模助手，需要根据库表结构和少量样本数据，为单张表生成结构化语义配置。',
    '请只输出 JSON，不要输出 markdown、解释或代码块。',
    '输出必须符合以下结构：',
    '{ table, description, metrics, dimensions, timeFields, identifierFields, nerEnabledFields, fields }',
    'fields 中每一项都必须包含 table, column, metricName, description, metricType, calcMode, enableForNer, aliases, semanticRole, derivedFrom。',
    '要求：',
    '1. 只能使用给定字段名，不要发明列名。',
    '2. 尽量结合样本值推断字段角色与业务别名。',
    '3. 每个字段都要有一个结果项。',
    '4. derivedFrom 请统一写成 manual。',
    '5. 描述要简洁专业，适合后续在 DB Harness 与 NL2DATA 中直接消费。',
    '',
    `表名：${table.name}`,
    `表说明：${table.detail || table.name}`,
    `结构：${compactJson(table)}`,
    `当前默认语义草稿：${compactJson(fallbackEntity)}`,
    `样本数据：${compactJson(previewRows)}`,
  ].join('\n');

  const abortController = new AbortController();
  const timeoutMs = 12000;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: buildAIModelHeaders(profile),
      body: JSON.stringify({
        model: selectedModel.modelId,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: 'You are a precise JSON generator for database semantic models.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(`模型请求超时（${timeoutMs / 1000}s），已回退到规则生成。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const parsed = parseJsonSafely(text);
  if (!response.ok) {
    const message = isRecord(parsed) && typeof parsed.error === 'string'
      ? parsed.error
      : `模型请求失败：${response.status}`;
    throw new Error(message);
  }

  const content = isRecord(parsed)
    && Array.isArray(parsed.choices)
    && parsed.choices[0]
    && isRecord(parsed.choices[0])
    && isRecord(parsed.choices[0].message)
    && typeof parsed.choices[0].message.content === 'string'
    ? parsed.choices[0].message.content
    : '';
  const json = extractJsonObject(content);
  const entity = normalizeGeneratedEntity(json, table.name, schema, metricMappings, fallbackEntity);

  return {
    entity,
    modelLabel: `${profile.name} / ${selectedModel.modelId}`,
  };
}

async function generateSemanticModel(instanceId: string): Promise<DatabaseSemanticModel> {
  const instance = getDatabaseInstanceById(instanceId);
  if (!instance) {
    throw new Error('数据库实例不存在');
  }

  const schema = await getDatabaseSchema(instance);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: instance.metricMappings,
    semanticModel: instance.semanticModel,
  });

  return {
    ...deriveSemanticSnapshot(schema, metricMappings),
    source: 'generated',
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const instance = getDatabaseInstanceById(id);
    if (!instance) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    const semanticModel = sanitizeDatabaseSemanticModel(instance.semanticModel) || await generateSemanticModel(id);
    return NextResponse.json(semanticModel);
  } catch (error) {
    console.error('Failed to get semantic model:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取语义模型失败' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as SemanticGenerationRequestBody;
    const persist = body.persist === true;
    const instance = getDatabaseInstanceById(id);
    if (!instance) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    const schema = await getDatabaseSchema(instance);
    const metricMappings = getEffectiveDatabaseMetricMappings({
      metricMappings: instance.metricMappings,
      semanticModel: instance.semanticModel,
    });
    const currentSemanticModel = sanitizeDatabaseSemanticModel(instance.semanticModel) || buildDefaultSemanticModel(schema, metricMappings);
    const tableName = typeof body.collection === 'string' && body.collection.trim()
      ? body.collection.trim()
      : schema.collections.find((item) => item.category === 'table')?.name || '';
    if (!tableName) {
      return NextResponse.json({ error: '当前实例没有可生成语义的表' }, { status: 400 });
    }

    const selectedTable = schema.collections.find((item) => item.name === tableName && item.category === 'table');
    if (!selectedTable) {
      return NextResponse.json({ error: '选中的表不存在' }, { status: 404 });
    }

    const currentEntity = currentSemanticModel.entities.find((entity) => entity.table === tableName) || null;
    const preview = await getDatabaseCollectionPreview(instance, tableName);
    let generatedEntity = buildDefaultSemanticEntity(tableName, schema, metricMappings, currentEntity);
    let message = `已基于 ${tableName} 的库表结构生成语义草稿。`;

    if (body.selectedModel?.profileId && body.selectedModel?.modelId) {
      try {
        const aiResult = await requestAiSemanticModel(schema, metricMappings, selectedTable, preview.rows.slice(0, 8), body.selectedModel);
        generatedEntity = aiResult.entity;
        message = `已使用 ${aiResult.modelLabel} 基于 ${tableName} 的结构与样本数据生成语义草稿。`;
      } catch (error) {
        message = error instanceof Error
          ? `${error.message}，已回退到基于库表结构的规则生成。`
          : '模型生成失败，已回退到基于库表结构的规则生成。';
      }
    }

    const nextEntities = currentSemanticModel.entities.filter((entity) => entity.table !== tableName);
    nextEntities.push(generatedEntity);
    const semanticModel = sanitizeDatabaseSemanticModel({
      ...currentSemanticModel,
      entities: nextEntities,
      source: 'generated',
      updatedAt: new Date().toISOString(),
    }) || currentSemanticModel;

    if (persist) {
      const updated = updateDatabaseInstanceSemanticModel(id, semanticModel);
      if (!updated) {
        return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
      }
      return NextResponse.json({
        ...(updated.semanticModel || semanticModel),
        message,
      });
    }

    return NextResponse.json({
      ...semanticModel,
      message,
    });
  } catch (error) {
    console.error('Failed to generate semantic model:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '生成语义模型失败' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const semanticModel = sanitizeDatabaseSemanticModel(body?.semanticModel);
    if (!semanticModel) {
      return NextResponse.json({ error: '语义模型格式不正确。' }, { status: 400 });
    }

    const updated = updateDatabaseInstanceSemanticModel(id, {
      ...semanticModel,
      source: 'manual',
      updatedAt: new Date().toISOString(),
    });
    if (!updated) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    return NextResponse.json(updated.semanticModel);
  } catch (error) {
    console.error('Failed to update semantic model:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '保存语义模型失败' }, { status: 500 });
  }
}

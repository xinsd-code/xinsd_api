import { buildAIModelHeaders } from '@/lib/ai-models';
import { DatabaseSchemaPayload, AIModelProfile } from '@/lib/types';
import { DatabaseMetricViewMap, DBHarnessKnowledgeMemoryEntry, DBHarnessSemanticEmbeddingIndex, DBHarnessSemanticEmbeddingMatch } from '../core/types';
import { dedupeStrings, isRecord, parseJsonSafely, truncateText } from '../core/utils';

function normalizeVector(values: number[]): number[] {
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(length) || length <= 0) {
    return values;
  }
  return values.map((value) => value / length);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  if (!size) return 0;
  let dot = 0;
  let leftLength = 0;
  let rightLength = 0;
  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    dot += leftValue * rightValue;
    leftLength += leftValue * leftValue;
    rightLength += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftLength) * Math.sqrt(rightLength);
  return denominator > 0 ? dot / denominator : 0;
}

function buildEmbeddingEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, '');
  return normalized.endsWith('/embeddings') ? normalized : `${normalized}/embeddings`;
}

function buildFieldText(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap,
  collection: DatabaseSchemaPayload['collections'][number],
  column: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>[number]
): { id: string; kind: 'field'; label: string; table: string; column: string; text: string; tags: string[] } {
  const metric = metricMappings[collection.name]?.fields?.[column.name];
  const label = metric?.metricName || column.comment || column.name;
  const tags = dedupeStrings([
    collection.name,
    column.name,
    column.comment,
    metric?.metricName,
    metric?.description,
    ...(metric?.aliases || []),
    column.referencesTable,
    column.referencesColumn,
  ], 36);
  return {
    id: `${collection.name}.${column.name}`,
    kind: 'field',
    label,
    table: collection.name,
    column: column.name,
    text: [
      `表: ${collection.name}`,
      `字段: ${column.name}`,
      `口径: ${label}`,
      metric?.description ? `说明: ${metric.description}` : '',
      metric?.metricType ? `类型: ${metric.metricType}` : '',
      metric?.calcMode ? `计算: ${metric.calcMode}` : '',
      metric?.aliases?.length ? `别名: ${metric.aliases.join('、')}` : '',
      column.comment ? `注释: ${column.comment}` : '',
      column.referencesTable ? `关联表: ${column.referencesTable}` : '',
      schema.engine ? `引擎: ${schema.engine}` : '',
    ].filter(Boolean).join(' | '),
    tags,
  };
}

function buildKnowledgeText(entry: DBHarnessKnowledgeMemoryEntry): { id: string; kind: 'knowledge'; label: string; text: string; tags: string[] } {
  const label = entry.correctionRule?.correctMapping.label || entry.summary.slice(0, 48) || entry.key;
  return {
    id: entry.key,
    kind: 'knowledge',
    label,
    text: [
      `记忆: ${entry.summary}`,
      entry.feedbackType ? `类型: ${entry.feedbackType}` : '',
      entry.correctionRule ? `规则: ${entry.correctionRule.wrongMapping.label || entry.correctionRule.note || ''} -> ${entry.correctionRule.correctMapping.label || ''}` : '',
      entry.tags.length ? `标签: ${entry.tags.join('、')}` : '',
    ].filter(Boolean).join(' | '),
    tags: entry.tags,
  };
}

async function fetchEmbeddings(input: {
  endpoint: string;
  profile: AIModelProfile;
  modelId: string;
  texts: string[];
}): Promise<number[][]> {
  const response = await fetch(input.endpoint, {
    method: 'POST',
    headers: buildAIModelHeaders(input.profile),
    body: JSON.stringify({
      model: input.modelId,
      input: input.texts,
      encoding_format: 'float',
    }),
    signal: AbortSignal.timeout(25000),
  });

  const upstreamText = await response.text();
  const upstreamJson = parseJsonSafely(upstreamText);

  if (!response.ok) {
    const message = isRecord(upstreamJson) && isRecord(upstreamJson.error) && typeof upstreamJson.error.message === 'string'
      ? upstreamJson.error.message
      : 'Embedding 请求失败';
    throw new Error(message);
  }

  if (!isRecord(upstreamJson) || !Array.isArray(upstreamJson.data)) {
    throw new Error('Embedding 接口返回格式不正确');
  }

  return upstreamJson.data
    .map((item) => (isRecord(item) && Array.isArray(item.embedding)
      ? item.embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : []))
    .filter((vector) => vector.length > 0);
}

export async function buildSemanticEmbeddingIndex(input: {
  profile: AIModelProfile;
  modelId: string;
  endpoint: string;
  schema: DatabaseSchemaPayload;
  metricMappings: DatabaseMetricViewMap;
  knowledge: DBHarnessKnowledgeMemoryEntry[];
  runtimeConfig?: {
    semanticEmbeddingLimit?: number;
  };
}): Promise<DBHarnessSemanticEmbeddingIndex | null> {
  if (input.profile.modelType !== 'embedding' || !input.endpoint) {
    return null;
  }

  const fieldItems = (input.schema.collections || [])
    .filter((collection) => collection.category === 'table')
    .flatMap((collection) => (collection.columns || []).map((column) => buildFieldText(input.schema, input.metricMappings, collection, column)))
    .slice(0, Math.max(16, Math.min(input.runtimeConfig?.semanticEmbeddingLimit || 48, 96)));

  const knowledgeItems = input.knowledge
    .slice(0, Math.max(8, Math.min((input.runtimeConfig?.semanticEmbeddingLimit || 48) / 2, 24)))
    .map((entry) => buildKnowledgeText(entry));

  const items = [...fieldItems, ...knowledgeItems];
  if (items.length === 0) {
    return null;
  }

  const embeddings = await fetchEmbeddings({
    endpoint: buildEmbeddingEndpoint(input.endpoint),
    profile: input.profile,
    modelId: input.modelId || input.profile.defaultModelId || input.profile.modelIds[0] || '',
    texts: items.map((item) => item.text),
  });

  if (embeddings.length !== items.length) {
    return null;
  }

  return {
    profile: input.profile,
    sourceProfileId: input.profile.id,
    sourceModelId: input.modelId || input.profile.defaultModelId || input.profile.modelIds[0] || '',
    endpoint: buildEmbeddingEndpoint(input.endpoint),
    builtAt: new Date().toISOString(),
    items: items.map((item, index) => ({
      kind: item.kind,
      id: item.id,
      label: truncateText(item.label, 80) || item.label,
      table: 'table' in item ? item.table : undefined,
      column: 'column' in item ? item.column : undefined,
      summary: truncateText('text' in item ? item.text : '', 200) || '',
      tags: item.tags.slice(0, 8),
      embedding: normalizeVector(embeddings[index] || []),
    })),
  };
}

export async function rankSemanticEmbeddingMatches(
  question: string,
  index: DBHarnessSemanticEmbeddingIndex | null | undefined,
  limit = 12
): Promise<DBHarnessSemanticEmbeddingMatch[]> {
  if (!index || !question.trim()) {
    return [];
  }

  const questionVectors = await fetchEmbeddings({
    endpoint: index.endpoint,
    profile: index.profile,
    modelId: index.sourceModelId,
    texts: [question],
  });

  const questionEmbedding = normalizeVector(questionVectors[0] || []);
  if (!questionEmbedding.length) {
    return [];
  }

  return index.items
    .map((item) => ({
      kind: item.kind,
      id: item.id,
      label: item.label,
      table: item.table,
      column: item.column,
      summary: item.summary,
      score: cosineSimilarity(questionEmbedding, item.embedding),
      tags: item.tags,
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(limit, 24)));
}

export function buildSemanticEmbeddingOverview(matches: DBHarnessSemanticEmbeddingMatch[], limit = 8) {
  return matches.slice(0, limit).map((match) => ({
    kind: match.kind,
    label: match.label,
    table: match.table,
    column: match.column,
    score: Number(match.score.toFixed(3)),
    summary: match.summary,
    tags: match.tags.slice(0, 4),
  }));
}

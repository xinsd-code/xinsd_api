import { buildAIModelEndpoint, buildAiChatEndpoint } from '@/lib/ai-models';
import {
  getAIModelProfileById,
  getDatabaseInstanceById,
  getDBHarnessWorkspaceById,
  listDBHarnessKnowledgeMemory,
  listDBHarnessPromptTemplates,
} from '@/lib/db';
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { DBHarnessChatTurnRequest, DBHarnessWorkspaceContext, DatabaseMetricViewMap } from '../core/types';
import { buildSemanticEmbeddingIndex } from '../memory/embedding-index';
import { deriveCatalogSnapshot, deriveSemanticSnapshot } from '../tools/catalog-tools';
import { buildKnowledgeQualitySnapshot, buildWorkspaceFreshnessSnapshot } from './workspace-insights';
import {
  buildWorkspaceCacheKey,
  getCachedWorkspaceContext,
  setCachedWorkspaceContext,
} from './workspace-cache';

export async function resolveDBHarnessWorkspace(input: DBHarnessChatTurnRequest): Promise<DBHarnessWorkspaceContext> {
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
    throw new Error('DB-Multi-Agent 暂时仅支持 MySQL、PostgreSQL 和 MongoDB 数据源。');
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

  const workspaceRecord = input.workspaceId
    ? getDBHarnessWorkspaceById(input.workspaceId)
    : null;
  const promptTemplates = listDBHarnessPromptTemplates({
    workspaceId: workspaceRecord?.id || input.workspaceId,
    databaseId: databaseInstance.id,
    limit: 12,
  });
  const promptTemplatesUpdatedAt = promptTemplates.reduce((latest, item) => {
    const current = Date.parse(item.updatedAt || '');
    const previous = Date.parse(latest || '');
    if (!Number.isFinite(current)) return latest;
    if (!Number.isFinite(previous)) return item.updatedAt;
    return current > previous ? item.updatedAt : latest;
  }, '');
  const nerSelectedModel = input.nerSelectedModel || null;
  const nerProfile = nerSelectedModel ? getAIModelProfileById(nerSelectedModel.profileId) : profile;
  if (nerSelectedModel && !nerProfile) {
    throw new Error('NER 模型配置不存在，请重新选择模型。');
  }
  if (nerSelectedModel && nerProfile && !nerProfile.modelIds.includes(nerSelectedModel.modelId)) {
    throw new Error('NER 模型来源未包含所选 Model ID。');
  }
  const resolvedNerProfile = nerSelectedModel ? nerProfile || undefined : undefined;
  const nerEndpoint = resolvedNerProfile ? buildAIModelEndpoint(resolvedNerProfile.baseUrl, resolvedNerProfile.modelType) : endpoint;
  if (nerSelectedModel && !nerEndpoint) {
    throw new Error('NER 模型的 Base URL 无效。');
  }

  const cacheKey = buildWorkspaceCacheKey({
    workspaceId: workspaceRecord?.id || input.workspaceId || '',
    databaseId: databaseInstance.id,
    workspaceUpdatedAt: workspaceRecord?.updatedAt || '',
    databaseUpdatedAt: databaseInstance.updatedAt || '',
    semanticModelUpdatedAt: databaseInstance.semanticModel?.updatedAt || '',
    promptTemplatesUpdatedAt,
  });
  const cached = getCachedWorkspaceContext(cacheKey);
  if (cached) {
    const freshness = buildWorkspaceFreshnessSnapshot({
      workspaceUpdatedAt: workspaceRecord?.updatedAt || '',
      databaseUpdatedAt: databaseInstance.updatedAt || '',
      semanticModelUpdatedAt: databaseInstance.semanticModel?.updatedAt || '',
      cacheBuiltAt: cached.cachedAt,
    });
    const knowledgeQuality = buildKnowledgeQualitySnapshot(cached.knowledge);
    return {
      workspaceId: cached.workspaceId,
      workspaceRules: cached.workspaceRules,
      runtimeConfig: workspaceRecord?.runtimeConfig || {},
      freshness,
      knowledgeQuality,
      databaseInstance: cached.databaseInstance,
      profile,
      selectedModel,
      endpoint,
      nerProfile: resolvedNerProfile,
      nerSelectedModel: nerSelectedModel || undefined,
      nerEndpoint: nerSelectedModel ? nerEndpoint : undefined,
      schema: cached.schema,
      metricMappings: cached.metricMappings,
      catalog: cached.catalog,
      semantic: cached.semantic,
      knowledge: cached.knowledge,
      promptTemplates: cached.promptTemplates,
      semanticEmbeddingIndex: cached.semanticEmbeddingIndex,
    };
  }

  const schema = await getDatabaseSchema(databaseInstance);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: databaseInstance.metricMappings,
    semanticModel: databaseInstance.semanticModel,
  }) as DatabaseMetricViewMap;
  const catalog = deriveCatalogSnapshot(schema, metricMappings);
  const semantic = sanitizeDatabaseSemanticModel(databaseInstance.semanticModel) || deriveSemanticSnapshot(schema, metricMappings);
  const knowledge = listDBHarnessKnowledgeMemory({
    workspaceId: workspaceRecord?.id || input.workspaceId,
    databaseId: databaseInstance.id,
    limit: 24,
  });
  const freshness = buildWorkspaceFreshnessSnapshot({
    workspaceUpdatedAt: workspaceRecord?.updatedAt || '',
    databaseUpdatedAt: databaseInstance.updatedAt || '',
    semanticModelUpdatedAt: databaseInstance.semanticModel?.updatedAt || '',
  });
  const knowledgeQuality = buildKnowledgeQualitySnapshot(knowledge);
  let semanticEmbeddingIndex = null;
  if (resolvedNerProfile?.modelType === 'embedding' && nerEndpoint) {
    try {
      semanticEmbeddingIndex = await buildSemanticEmbeddingIndex({
        profile: resolvedNerProfile,
        modelId: nerSelectedModel?.modelId || resolvedNerProfile.defaultModelId || resolvedNerProfile.modelIds[0] || '',
        endpoint: nerEndpoint,
        schema,
        metricMappings,
        knowledge,
        runtimeConfig: workspaceRecord?.runtimeConfig || {},
      });
    } catch (error) {
      console.warn('DB Harness semantic embedding index build skipped:', error instanceof Error ? error.message : String(error));
      semanticEmbeddingIndex = null;
    }
  }

  const cacheEntry = {
    cacheKey,
    cachedAt: new Date().toISOString(),
    workspaceId: workspaceRecord?.id || input.workspaceId,
    workspaceRules: workspaceRecord?.rules || '',
    databaseInstance,
    schema,
    metricMappings,
    catalog,
    semantic,
    knowledge,
    promptTemplates,
    freshness,
    knowledgeQuality,
    semanticEmbeddingIndex,
  };
  setCachedWorkspaceContext(cacheEntry);

  return {
    workspaceId: cacheEntry.workspaceId,
    workspaceRules: cacheEntry.workspaceRules,
    runtimeConfig: workspaceRecord?.runtimeConfig || {},
    databaseInstance,
    profile,
    selectedModel,
    endpoint,
    nerProfile: resolvedNerProfile,
    nerSelectedModel: nerSelectedModel || undefined,
    nerEndpoint: nerSelectedModel ? nerEndpoint : undefined,
    schema,
    metricMappings,
    catalog,
    semantic,
    knowledge,
    promptTemplates,
    freshness,
    knowledgeQuality,
    semanticEmbeddingIndex,
  };
}

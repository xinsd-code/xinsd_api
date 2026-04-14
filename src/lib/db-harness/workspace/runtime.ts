import { buildAiChatEndpoint } from '@/lib/ai-models';
import {
  getAIModelProfileById,
  getDatabaseInstanceById,
  getDBHarnessWorkspaceById,
  listDBHarnessKnowledgeMemory,
} from '@/lib/db';
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { DBHarnessChatTurnRequest, DBHarnessWorkspaceContext, DatabaseMetricViewMap } from '../core/types';
import { deriveCatalogSnapshot, deriveSemanticSnapshot } from '../tools/catalog-tools';
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

  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql') {
    throw new Error('DB-Multi-Agent 暂时仅支持 MySQL 和 PostgreSQL 数据源。');
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
  const nerSelectedModel = input.nerSelectedModel || null;
  const nerProfile = nerSelectedModel ? getAIModelProfileById(nerSelectedModel.profileId) : profile;
  if (nerSelectedModel && !nerProfile) {
    throw new Error('NER 模型配置不存在，请重新选择模型。');
  }
  if (nerSelectedModel && nerProfile && !nerProfile.modelIds.includes(nerSelectedModel.modelId)) {
    throw new Error('NER 模型来源未包含所选 Model ID。');
  }
  const resolvedNerProfile = nerSelectedModel ? nerProfile || undefined : undefined;
  const nerEndpoint = resolvedNerProfile ? buildAiChatEndpoint(resolvedNerProfile.baseUrl) : endpoint;
  if (nerSelectedModel && !nerEndpoint) {
    throw new Error('NER 模型的 Base URL 无效。');
  }

  const cacheKey = buildWorkspaceCacheKey({
    workspaceId: workspaceRecord?.id || input.workspaceId || '',
    databaseId: databaseInstance.id,
    workspaceUpdatedAt: workspaceRecord?.updatedAt || '',
    databaseUpdatedAt: databaseInstance.updatedAt || '',
  });
  const cached = getCachedWorkspaceContext(cacheKey);
  if (cached) {
    return {
      workspaceId: cached.workspaceId,
      workspaceRules: cached.workspaceRules,
      runtimeConfig: workspaceRecord?.runtimeConfig || {},
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
  };
}

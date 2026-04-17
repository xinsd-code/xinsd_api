import type { DatabaseInstance } from '@/lib/types';
import type {
  DBHarnessCatalogSnapshot,
  DBHarnessKnowledgeMemoryEntry,
  DBHarnessPromptTemplateRecord,
  DBHarnessSemanticEmbeddingIndex,
  DBHarnessSemanticSnapshot,
  DatabaseMetricViewMap,
} from '../core/types';
import type { DatabaseSchemaPayload } from '@/lib/types';

export interface DBHarnessWorkspaceCacheEntry {
  cacheKey: string;
  cachedAt: string;
  workspaceId?: string;
  workspaceRules?: string;
  databaseInstance: DatabaseInstance;
  schema: DatabaseSchemaPayload;
  metricMappings: DatabaseMetricViewMap;
  catalog: DBHarnessCatalogSnapshot;
  semantic: DBHarnessSemanticSnapshot;
  knowledge: DBHarnessKnowledgeMemoryEntry[];
  promptTemplates?: DBHarnessPromptTemplateRecord[];
  semanticEmbeddingIndex?: DBHarnessSemanticEmbeddingIndex | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const workspaceCache = new Map<string, DBHarnessWorkspaceCacheEntry>();

export function buildWorkspaceCacheKey(input: {
  workspaceId?: string;
  databaseId: string;
  workspaceUpdatedAt?: string;
  databaseUpdatedAt?: string;
  semanticModelUpdatedAt?: string;
  promptTemplatesUpdatedAt?: string;
}): string {
  return [
    input.workspaceId || '',
    input.databaseId,
    input.workspaceUpdatedAt || '',
    input.databaseUpdatedAt || '',
    input.semanticModelUpdatedAt || '',
    input.promptTemplatesUpdatedAt || '',
  ].join('|');
}

export function getCachedWorkspaceContext(cacheKey: string): DBHarnessWorkspaceCacheEntry | null {
  const entry = workspaceCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - Date.parse(entry.cachedAt) > CACHE_TTL_MS) {
    workspaceCache.delete(cacheKey);
    return null;
  }
  return entry;
}

export function setCachedWorkspaceContext(entry: DBHarnessWorkspaceCacheEntry): void {
  workspaceCache.set(entry.cacheKey, entry);
}

export function invalidateWorkspaceContextCache(input: { workspaceId?: string; databaseId?: string }): void {
  const workspaceId = input.workspaceId?.trim() || '';
  const databaseId = input.databaseId?.trim() || '';
  if (!workspaceId && !databaseId) {
    workspaceCache.clear();
    return;
  }

  for (const [cacheKey, entry] of workspaceCache.entries()) {
    const hitWorkspace = workspaceId ? entry.workspaceId === workspaceId : true;
    const hitDatabase = databaseId ? entry.databaseInstance.id === databaseId : true;
    if (hitWorkspace && hitDatabase) {
      workspaceCache.delete(cacheKey);
    }
  }
}

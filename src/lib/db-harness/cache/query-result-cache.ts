import { createHash } from 'node:crypto';
import { normalizeSqlForExecution } from '@/lib/sql-normalize';
import { normalizeMongoQueryText } from '@/lib/mongo-query-compat';
import { DatabaseInstanceType } from '@/lib/types';
import { DBHarnessExecutionPayload } from '../core/types';

export interface DBHarnessQueryResultCacheEntry {
  cacheKey: string;
  engine: DatabaseInstanceType;
  databaseId: string;
  queryFingerprint: string;
  cachedAt: string;
  execution: DBHarnessExecutionPayload;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const queryResultCache = new Map<string, DBHarnessQueryResultCacheEntry>();

function normalizeQueryText(engine: DatabaseInstanceType, sql: string): string {
  const text = engine === 'mongo'
    ? normalizeMongoQueryText(sql)
    : normalizeSqlForExecution(engine, sql);
  return text.trim().replace(/\s+/g, ' ');
}

export function buildQueryResultFingerprint(input: {
  databaseId: string;
  engine: DatabaseInstanceType;
  sql: string;
}): string {
  const normalized = normalizeQueryText(input.engine, input.sql);
  return createHash('sha256')
    .update([input.databaseId.trim(), input.engine, normalized].join('|'))
    .digest('hex');
}

export function buildQueryResultCacheKey(input: {
  databaseId: string;
  engine: DatabaseInstanceType;
  sql: string;
}): string {
  return `${input.databaseId.trim()}:${input.engine}:${buildQueryResultFingerprint(input)}`;
}

export function getCachedQueryExecution(input: {
  databaseId: string;
  engine: DatabaseInstanceType;
  sql: string;
}): DBHarnessQueryResultCacheEntry | null {
  const cacheKey = buildQueryResultCacheKey(input);
  const entry = queryResultCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - Date.parse(entry.cachedAt) > CACHE_TTL_MS) {
    queryResultCache.delete(cacheKey);
    return null;
  }
  return entry;
}

export function setCachedQueryExecution(entry: DBHarnessQueryResultCacheEntry): void {
  queryResultCache.set(entry.cacheKey, entry);
}

export function cacheQueryExecution(input: {
  databaseId: string;
  engine: DatabaseInstanceType;
  sql: string;
  execution: DBHarnessExecutionPayload;
}): DBHarnessQueryResultCacheEntry {
  const cacheKey = buildQueryResultCacheKey(input);
  const entry: DBHarnessQueryResultCacheEntry = {
    cacheKey,
    engine: input.engine,
    databaseId: input.databaseId.trim(),
    queryFingerprint: buildQueryResultFingerprint(input),
    cachedAt: new Date().toISOString(),
    execution: input.execution,
  };
  setCachedQueryExecution(entry);
  return entry;
}

export function invalidateQueryExecutionCache(input: { databaseId?: string } = {}): void {
  const databaseId = input.databaseId?.trim() || '';
  if (!databaseId) {
    queryResultCache.clear();
    return;
  }

  for (const [cacheKey, entry] of queryResultCache.entries()) {
    if (entry.databaseId === databaseId) {
      queryResultCache.delete(cacheKey);
    }
  }
}

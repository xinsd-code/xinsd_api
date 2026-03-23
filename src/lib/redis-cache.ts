import 'server-only';

import { getDatabaseInstanceById } from './db';
import { resolveRedisConnection } from './database-instances';
import { sanitizeRedisCacheConfig } from './redis-cache-config';
import { RedisCacheConfig } from './types';

type AppRedisClient = ReturnType<(typeof import('redis'))['createClient']>;

export interface RedisCacheWriteResult {
  enabled: boolean;
  instanceId?: string;
  key?: string;
  expireSeconds?: number;
  ok?: boolean;
  skipped?: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function tokenizePath(pathExpression: string): string[] {
  return pathExpression
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function resolvePathValue(source: unknown, pathExpression: string): unknown {
  if (!pathExpression) return undefined;

  if (isRecord(source) && pathExpression in source) {
    return source[pathExpression];
  }

  const segments = tokenizePath(pathExpression);
  if (!segments.length) return undefined;

  let current: unknown = source;
  for (const [index, segment] of segments.entries()) {
    if (typeof current === 'string' && index > 0) {
      current = tryParseJson(current);
    }

    if (Array.isArray(current)) {
      const targetIndex = Number(segment);
      if (!Number.isInteger(targetIndex)) {
        return undefined;
      }
      current = current[targetIndex];
      continue;
    }

    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function stringifyResolvedValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function resolveRedisKeyRule(rule: string, params: unknown): string {
  return rule.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_token, expression: string) => {
    const resolved = resolvePathValue(params, expression.trim());
    return stringifyResolvedValue(resolved);
  });
}

export function buildRedisCacheKey(forwardId: string, keyRule: string, params: unknown): string {
  const resolvedRule = resolveRedisKeyRule(keyRule, params).trim();
  if (!resolvedRule) {
    throw new Error('Redis Key 规则解析后为空');
  }
  return `${forwardId}:${resolvedRule}`;
}

async function withRedisClient<T>(instanceId: string, fn: (client: AppRedisClient) => Promise<T>): Promise<T> {
  const instance = getDatabaseInstanceById(instanceId);
  if (!instance) {
    throw new Error('Redis 数据源不存在');
  }
  if (instance.type !== 'redis') {
    throw new Error('所选数据源不是 Redis');
  }

  const { createClient } = await import('redis');
  const target = resolveRedisConnection(instance.connectionUri);
  const client = createClient({
    socket: {
      host: target.host,
      port: target.port,
      connectTimeout: 5000,
    },
    password: instance.password || undefined,
    database: Number(target.database || '0'),
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    if (client.isOpen) {
      await client.quit().catch(async () => {
        if (client.isOpen) {
          await client.disconnect();
        }
      });
    }
  }
}

function serializeCachePayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  return JSON.stringify(payload);
}

export async function writeRedisCacheValue(
  forwardId: string,
  redisConfig: RedisCacheConfig | undefined,
  params: unknown,
  payload: unknown
): Promise<RedisCacheWriteResult> {
  const config = sanitizeRedisCacheConfig(redisConfig);
  if (!config.enabled) {
    return { enabled: false, skipped: true };
  }

  if (!config.instanceId || !config.keyRule) {
    return {
      enabled: true,
      instanceId: config.instanceId,
      ok: false,
      error: 'Redis 缓存配置不完整',
    };
  }

  try {
    const key = buildRedisCacheKey(forwardId, config.keyRule, params);
    const value = serializeCachePayload(payload);

    await withRedisClient(config.instanceId, async (client) => {
      if (config.expireSeconds) {
        await client.sendCommand(['SETEX', key, String(config.expireSeconds), value]);
        return;
      }
      await client.set(key, value);
    });

    return {
      enabled: true,
      instanceId: config.instanceId,
      key,
      expireSeconds: config.expireSeconds,
      ok: true,
    };
  } catch (error) {
    return {
      enabled: true,
      instanceId: config.instanceId,
      ok: false,
      error: error instanceof Error ? error.message : 'Redis 缓存写入失败',
    };
  }
}

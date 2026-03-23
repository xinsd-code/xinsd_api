import { RedisCacheConfig } from './types';

export function sanitizeRedisCacheConfig(input?: RedisCacheConfig | null): RedisCacheConfig {
  const enabled = Boolean(input?.enabled);
  const instanceId = typeof input?.instanceId === 'string' ? input.instanceId.trim() : '';
  const keyRule = typeof input?.keyRule === 'string' ? input.keyRule.trim() : '';
  const expireSeconds =
    typeof input?.expireSeconds === 'number' && Number.isFinite(input.expireSeconds) && input.expireSeconds > 0
      ? Math.floor(input.expireSeconds)
      : undefined;

  if (!enabled) {
    return { enabled: false };
  }

  return {
    enabled: true,
    instanceId: instanceId || undefined,
    keyRule: keyRule || undefined,
    expireSeconds,
  };
}

export function validateRedisCacheConfig(
  input?: RedisCacheConfig | null,
  options?: {
    hasRedisSource?: boolean;
    allowDisabled?: boolean;
  }
): string | null {
  const config = sanitizeRedisCacheConfig(input);
  if (!config.enabled) {
    return options?.allowDisabled === false ? 'Redis 缓存当前未开启' : null;
  }

  if (options?.hasRedisSource === false) {
    return '暂无 Redis 数据源，请先前往「数据库实例」接入 Redis';
  }

  if (!config.instanceId) {
    return '请选择 Redis 数据源';
  }

  if (!config.keyRule) {
    return '请填写 Redis Key 规则';
  }

  if (
    input?.expireSeconds !== undefined &&
    (!Number.isFinite(input.expireSeconds) || input.expireSeconds <= 0)
  ) {
    return 'Redis 过期时间必须是大于 0 的整数';
  }

  return null;
}

import {
  CreateDatabaseInstance,
  DatabaseFieldMetricMapping,
  DatabaseInstanceType,
  DatabaseMetricMappings,
  DatabaseTableMetricMapping,
} from './types';

interface ResolvedConnection {
  host: string;
  port: number;
  database?: string;
}

function normalizeConnectionUri(uri: string): string {
  return uri.trim();
}

function stripJdbcPrefix(uri: string, expectedPrefix: string): string {
  if (!uri.startsWith(expectedPrefix)) {
    throw new Error(`连接地址格式不正确，应以 ${expectedPrefix} 开头`);
  }
  return uri.slice('jdbc:'.length);
}

export function resolveSqlConnection(type: 'mysql' | 'pgsql', connectionUri: string): ResolvedConnection {
  const trimmed = normalizeConnectionUri(connectionUri);
  const url = new URL(
    type === 'mysql'
      ? stripJdbcPrefix(trimmed, 'jdbc:mysql://')
      : stripJdbcPrefix(trimmed, 'jdbc:postgresql://')
  );
  const database = url.pathname.replace(/^\/+/, '');
  if (!url.hostname || !url.port || !database) {
    throw new Error('连接地址中缺少 host、port 或 database 信息');
  }
  return {
    host: url.hostname,
    port: Number(url.port),
    database,
  };
}

export function resolveRedisConnection(connectionUri: string): ResolvedConnection {
  const trimmed = normalizeConnectionUri(connectionUri);
  if (trimmed.startsWith('redis://')) {
    const url = new URL(trimmed);
    if (!url.hostname || !url.port) {
      throw new Error('Redis 连接地址中缺少 host 或 port');
    }
    return {
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.replace(/^\/+/, '') || '0',
    };
  }

  const [host, port] = trimmed.split(':');
  if (!host || !port) {
    throw new Error('Redis 连接地址格式应为 host:port');
  }
  return {
    host,
    port: Number(port),
    database: '0',
  };
}

export function sanitizeDatabaseInstanceInput(input: Partial<CreateDatabaseInstance>): CreateDatabaseInstance {
  const type: DatabaseInstanceType = input.type === 'pgsql' || input.type === 'redis' ? input.type : 'mysql';
  return {
    name: typeof input.name === 'string' ? input.name.trim() : '',
    type,
    connectionUri: typeof input.connectionUri === 'string' ? normalizeConnectionUri(input.connectionUri) : '',
    username: typeof input.username === 'string' ? input.username.trim() : '',
    password: typeof input.password === 'string' ? input.password : '',
  };
}

export function validateDatabaseInstanceInput(input: CreateDatabaseInstance): string | null {
  if (!input.name) return '请输入实例名称';
  if (!input.connectionUri) return '请输入连接地址';
  if ((input.type === 'mysql' || input.type === 'pgsql') && !input.username) {
    return 'SQL 数据库用户名不能为空';
  }

  try {
    if (input.type === 'mysql' || input.type === 'pgsql') {
      resolveSqlConnection(input.type, input.connectionUri);
    } else {
      resolveRedisConnection(input.connectionUri);
    }
  } catch (error) {
    return error instanceof Error ? error.message : '连接地址格式不正确';
  }

  return null;
}

export function getDatabaseInstanceValidationSignature(input: CreateDatabaseInstance): string {
  return JSON.stringify({
    name: input.name,
    type: input.type,
    connectionUri: input.connectionUri,
    username: input.username || '',
    password: input.password || '',
  });
}

function sanitizeMetricMapping(value: unknown): DatabaseFieldMetricMapping | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;

  const metricName = typeof input.metricName === 'string' ? input.metricName.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const metricType = typeof input.metricType === 'string' ? input.metricType.trim() : '';
  const calcMode = typeof input.calcMode === 'string' ? input.calcMode.trim() : '';
  const enableForNer = input.enableForNer === true;
  const aliases = Array.isArray(input.aliases)
    ? input.aliases
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item, index, array) => item.length > 0 && array.indexOf(item) === index)
    : [];

  if (!metricName && !description && !metricType && !calcMode && !enableForNer && aliases.length === 0) {
    return null;
  }

  return {
    ...(metricName ? { metricName } : {}),
    ...(description ? { description } : {}),
    ...(metricType ? { metricType } : {}),
    ...(calcMode ? { calcMode } : {}),
    ...(enableForNer ? { enableForNer: true } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

function sanitizeTableMetricMapping(value: unknown): DatabaseTableMetricMapping | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;

  const tableDescription = typeof input.description === 'string' ? input.description.trim() : '';
  const rawFields = input.fields && typeof input.fields === 'object'
    ? input.fields as Record<string, unknown>
    : input;

  const nextFields: Record<string, DatabaseFieldMetricMapping> = {};
  Object.entries(rawFields).forEach(([columnName, mappingValue]) => {
    if (!columnName.trim() || columnName === 'description' || columnName === 'fields') return;
    const mapping = sanitizeMetricMapping(mappingValue);
    if (mapping) {
      nextFields[columnName] = mapping;
    }
  });

  if (!tableDescription && Object.keys(nextFields).length === 0) {
    return null;
  }

  return {
    ...(tableDescription ? { description: tableDescription } : {}),
    fields: nextFields,
  };
}

export function sanitizeDatabaseMetricMappings(input: unknown): DatabaseMetricMappings {
  if (!input || typeof input !== 'object') return {};

  const nextMappings: DatabaseMetricMappings = {};

  Object.entries(input as Record<string, unknown>).forEach(([tableName, tableValue]) => {
    if (!tableName.trim()) return;
    const mapping = sanitizeTableMetricMapping(tableValue);
    if (mapping) {
      nextMappings[tableName] = mapping;
    }
  });

  return nextMappings;
}

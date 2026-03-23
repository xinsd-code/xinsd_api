import { CreateDatabaseInstance, DatabaseInstanceType } from './types';

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

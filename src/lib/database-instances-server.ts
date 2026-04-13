import 'server-only';

import {
  CreateDatabaseInstance,
  DatabaseCollectionInfo,
  DatabaseInstance,
  DatabaseInstanceType,
  DatabasePreviewPayload,
  DatabaseQueryPayload,
  DatabaseSchemaPayload,
} from './types';
import { resolveRedisConnection, resolveSqlConnection } from './database-instances';

type MySqlConnection = import('mysql2/promise').Connection;
type PgClient = import('pg').Client;
type AppRedisClient = ReturnType<(typeof import('redis'))['createClient']>;

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return value.map((item) => serializeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serializeValue(item)])
    );
  }
  return value;
}

async function withMySql<T>(instance: DatabaseInstance | CreateDatabaseInstance, fn: (connection: MySqlConnection, database: string) => Promise<T>): Promise<T> {
  const mysql = await import('mysql2/promise');
  const target = resolveSqlConnection('mysql', instance.connectionUri);
  const connection = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: instance.username,
    password: instance.password,
    database: target.database,
    connectTimeout: 5000,
  });
  try {
    return await fn(connection, target.database!);
  } finally {
    await connection.end();
  }
}

async function withPg<T>(instance: DatabaseInstance | CreateDatabaseInstance, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const { Client } = await import('pg');
  const target = resolveSqlConnection('pgsql', instance.connectionUri);
  const client = new Client({
    host: target.host,
    port: target.port,
    user: instance.username,
    password: instance.password,
    database: target.database,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withRedis<T>(instance: DatabaseInstance | CreateDatabaseInstance, fn: (client: AppRedisClient) => Promise<T>): Promise<T> {
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
    await client.quit();
  }
}

export async function verifyDatabaseInstanceConnection(input: CreateDatabaseInstance): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  try {
    if (input.type === 'mysql') {
      await withMySql(input, async (connection) => {
        await connection.query('SELECT 1 AS ok');
      });
    } else if (input.type === 'pgsql') {
      await withPg(input, async (client) => {
        await client.query('SELECT 1 AS ok');
      });
    } else {
      await withRedis(input, async (client) => {
        await client.ping();
      });
    }

    return { ok: true, message: `${input.type.toUpperCase()} 连接验证通过` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '连接验证失败',
    };
  }
}

function quoteSqlIdentifier(type: DatabaseInstanceType, name: string): string {
  const parts = name.split('.');
  if (!parts.every((part) => /^[A-Za-z0-9_]+$/.test(part))) {
    throw new Error('表名格式不合法');
  }
  return parts
    .map((part) => (type === 'mysql' ? `\`${part}\`` : `"${part}"`))
    .join('.');
}

export function ensureSqlQueryIsReadonly(query: string): void {
  const normalized = query.trim().replace(/;+\s*$/, '').toLowerCase();
  if (!normalized) {
    throw new Error('请输入 SQL 语句');
  }
  const allowed = ['select', 'show', 'describe', 'desc', 'explain', 'with'];
  if (!allowed.some((keyword) => normalized.startsWith(keyword))) {
    throw new Error('当前仅允许执行只读 SQL 查询');
  }
}

function tokenizeRedisCommand(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) =>
    token.replace(/^['"]|['"]$/g, '')
  );
}

function ensureRedisCommandIsReadonly(tokens: string[]): void {
  const allowed = new Set([
    'get',
    'mget',
    'hget',
    'hgetall',
    'lrange',
    'smembers',
    'zrange',
    'zrevrange',
    'type',
    'ttl',
    'exists',
    'scan',
    'keys',
  ]);
  if (!tokens.length) {
    throw new Error('请输入 Redis 查询语句');
  }
  if (!allowed.has(tokens[0].toLowerCase())) {
    throw new Error('当前仅允许执行只读 Redis 查询命令');
  }
}

function rowsToPayloadRows(rows: Array<Record<string, unknown>>): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, serializeValue(value)])
    )
  );
}

export async function getDatabaseSchema(instance: DatabaseInstance): Promise<DatabaseSchemaPayload> {
  if (instance.type === 'mysql') {
    return withMySql(instance, async (connection, database) => {
      const [rows] = await connection.query(
        `
          SELECT
            cols.table_name AS tableName,
            cols.column_name AS columnName,
            cols.data_type AS dataType,
            cols.is_nullable AS isNullable,
            cols.column_default AS columnDefault,
            cols.column_key AS columnKey,
            cols.extra AS extra,
            cols.column_comment AS columnComment,
            kcu.referenced_table_name AS referencedTableName,
            kcu.referenced_column_name AS referencedColumnName
          FROM information_schema.columns cols
          LEFT JOIN information_schema.key_column_usage kcu
            ON cols.table_schema = kcu.table_schema
            AND cols.table_name = kcu.table_name
            AND cols.column_name = kcu.column_name
          WHERE cols.table_schema = ?
          ORDER BY cols.table_name, cols.ordinal_position
        `,
        [database]
      );
      const map = new Map<string, DatabaseCollectionInfo>();
      for (const row of rows as Array<Record<string, string | null>>) {
        const tableName = String(row.tableName || '');
        const current = map.get(tableName) || {
          name: tableName,
          category: 'table' as const,
          columns: [],
        };
        current.columns!.push({
          name: String(row.columnName),
          type: String(row.dataType),
          nullable: row.isNullable === 'YES',
          defaultValue: row.columnDefault ? String(row.columnDefault) : null,
          isPrimary: row.columnKey === 'PRI',
          extra: row.extra ? String(row.extra) : '',
          comment: row.columnComment ? String(row.columnComment) : '',
          referencesTable: row.referencedTableName ? String(row.referencedTableName) : '',
          referencesColumn: row.referencedColumnName ? String(row.referencedColumnName) : '',
        });
        map.set(tableName, current);
      }
      return { engine: 'mysql', collections: Array.from(map.values()) };
    });
  }

  if (instance.type === 'pgsql') {
    return withPg(instance, async (client) => {
      const result = await client.query(
        `
          SELECT
            CASE
              WHEN cols.table_schema = 'public' THEN cols.table_name
              ELSE cols.table_schema || '.' || cols.table_name
            END AS "tableName",
            cols.column_name AS "columnName",
            cols.data_type AS "dataType",
            cols.is_nullable AS "isNullable",
            cols.column_default AS "columnDefault",
            EXISTS (
              SELECT 1
              FROM information_schema.table_constraints tc
              INNER JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
                AND tc.table_name = kcu.table_name
              WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_schema = cols.table_schema
                AND tc.table_name = cols.table_name
                AND kcu.column_name = cols.column_name
            ) AS "isPrimary"
            ,
            col_description(
              format('%I.%I', cols.table_schema, cols.table_name)::regclass,
              cols.ordinal_position
            ) AS "columnComment",
            (
              SELECT ccu.table_name
              FROM information_schema.table_constraints tc
              INNER JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
                AND tc.table_name = kcu.table_name
              INNER JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.constraint_schema = tc.table_schema
              WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = cols.table_schema
                AND tc.table_name = cols.table_name
                AND kcu.column_name = cols.column_name
              LIMIT 1
            ) AS "referencedTableName",
            (
              SELECT ccu.column_name
              FROM information_schema.table_constraints tc
              INNER JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
                AND tc.table_name = kcu.table_name
              INNER JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.constraint_schema = tc.table_schema
              WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = cols.table_schema
                AND tc.table_name = cols.table_name
                AND kcu.column_name = cols.column_name
              LIMIT 1
            ) AS "referencedColumnName"
          FROM information_schema.columns cols
          INNER JOIN information_schema.tables tbl
            ON cols.table_schema = tbl.table_schema
            AND cols.table_name = tbl.table_name
          WHERE tbl.table_type = 'BASE TABLE'
            AND cols.table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY cols.table_schema, cols.table_name, cols.ordinal_position
        `
      );
      const map = new Map<string, DatabaseCollectionInfo>();
      for (const row of result.rows as Array<{
        tableName: string;
        columnName: string;
        dataType: string;
        isNullable: string;
        columnDefault: string | null;
        isPrimary: boolean;
        columnComment: string | null;
        referencedTableName: string | null;
        referencedColumnName: string | null;
      }>) {
        const current = map.get(row.tableName) || {
          name: row.tableName,
          category: 'table' as const,
          columns: [],
        };
        current.columns!.push({
          name: row.columnName,
          type: row.dataType,
          nullable: row.isNullable === 'YES',
          defaultValue: row.columnDefault,
          isPrimary: row.isPrimary,
          comment: row.columnComment || '',
          referencesTable: row.referencedTableName || '',
          referencesColumn: row.referencedColumnName || '',
        });
        map.set(row.tableName, current);
      }
      return { engine: 'pgsql', collections: Array.from(map.values()) };
    });
  }

  return withRedis(instance, async (client) => {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const reply = await client.scan(cursor, { COUNT: 100 });
      cursor = reply.cursor;
      keys.push(...reply.keys);
    } while (cursor !== '0' && keys.length < 200);

    const collections: DatabaseCollectionInfo[] = [];
    for (const key of keys.slice(0, 200)) {
      const type = await client.type(key);
      collections.push({
        name: key,
        category: 'key',
        detail: type,
      });
    }
    return { engine: 'redis', collections };
  });
}

async function getRedisKeyPreview(client: AppRedisClient, key: string): Promise<DatabasePreviewPayload> {
  const keyType = await client.type(key);
  if (keyType === 'string') {
    const value = await client.get(key);
    return {
      engine: 'redis',
      name: key,
      category: 'key',
      columns: ['key', 'value'],
      rows: [{ key, value }],
      summary: 'Redis String',
    };
  }
  if (keyType === 'hash') {
    const value = await client.hGetAll(key);
    return {
      engine: 'redis',
      name: key,
      category: 'key',
      columns: ['field', 'value'],
      rows: Object.entries(value).map(([field, item]) => ({ field, value: item })),
      summary: 'Redis Hash',
    };
  }
  if (keyType === 'list') {
    const value = await client.lRange(key, 0, 99);
    return {
      engine: 'redis',
      name: key,
      category: 'key',
      columns: ['index', 'value'],
      rows: value.map((item, index) => ({ index, value: item })),
      summary: 'Redis List',
    };
  }
  if (keyType === 'set') {
    const value = await client.sMembers(key);
    return {
      engine: 'redis',
      name: key,
      category: 'key',
      columns: ['value'],
      rows: value.map((item) => ({ value: item })),
      summary: 'Redis Set',
    };
  }
  if (keyType === 'zset') {
    const value = await client.zRangeWithScores(key, 0, 99);
    return {
      engine: 'redis',
      name: key,
      category: 'key',
      columns: ['value', 'score'],
      rows: value.map((item) => ({ value: item.value, score: item.score })),
      summary: 'Redis Sorted Set',
    };
  }

  return {
    engine: 'redis',
    name: key,
    category: 'key',
    columns: ['key', 'type'],
    rows: [{ key, type: keyType }],
    summary: `Redis ${keyType}`,
  };
}

export async function getDatabaseCollectionPreview(instance: DatabaseInstance, name: string): Promise<DatabasePreviewPayload> {
  if (instance.type === 'mysql') {
    return withMySql(instance, async (connection) => {
      const quoted = quoteSqlIdentifier('mysql', name);
      const [rows] = await connection.query(`SELECT * FROM ${quoted} LIMIT 50`);
      const payloadRows = rowsToPayloadRows(rows as Array<Record<string, unknown>>);
      return {
        engine: 'mysql',
        name,
        category: 'table',
        columns: payloadRows[0] ? Object.keys(payloadRows[0]) : [],
        rows: payloadRows,
        summary: `预览 ${name} 表前 50 条记录`,
      };
    });
  }

  if (instance.type === 'pgsql') {
    return withPg(instance, async (client) => {
      const quoted = quoteSqlIdentifier('pgsql', name);
      const result = await client.query(`SELECT * FROM ${quoted} LIMIT 50`);
      const payloadRows = rowsToPayloadRows(result.rows as Array<Record<string, unknown>>);
      return {
        engine: 'pgsql',
        name,
        category: 'table',
        columns: payloadRows[0] ? Object.keys(payloadRows[0]) : [],
        rows: payloadRows,
        summary: `预览 ${name} 表前 50 条记录`,
      };
    });
  }

  return withRedis(instance, async (client) => getRedisKeyPreview(client, name));
}

export async function executeDatabaseQuery(instance: DatabaseInstance, query: string): Promise<DatabaseQueryPayload> {
  return executeParameterizedDatabaseQuery(instance, query, []);
}

export async function executeParameterizedDatabaseQuery(
  instance: DatabaseInstance,
  query: string,
  values: unknown[] = []
): Promise<DatabaseQueryPayload> {
  if (instance.type === 'mysql') {
    ensureSqlQueryIsReadonly(query);
    return withMySql(instance, async (connection) => {
      const [rows, fields] = await connection.query(query, values);
      const payloadRows = rowsToPayloadRows(rows as Array<Record<string, unknown>>);
      const columns = payloadRows[0]
        ? Object.keys(payloadRows[0])
        : Array.isArray(fields)
          ? fields.map((field) => field.name)
          : [];
      return {
        engine: 'mysql',
        columns,
        rows: payloadRows,
        summary: `共返回 ${payloadRows.length} 行`,
      };
    });
  }

  if (instance.type === 'pgsql') {
    ensureSqlQueryIsReadonly(query);
    return withPg(instance, async (client) => {
      const result = await client.query(query, values);
      const payloadRows = rowsToPayloadRows(result.rows as Array<Record<string, unknown>>);
      const columns = payloadRows[0]
        ? Object.keys(payloadRows[0])
        : result.fields.map((field) => field.name);
      return {
        engine: 'pgsql',
        columns,
        rows: payloadRows,
        summary: `共返回 ${payloadRows.length} 行`,
      };
    });
  }

  const tokens = tokenizeRedisCommand(query);
  ensureRedisCommandIsReadonly(tokens);
  return withRedis(instance, async (client) => {
    const raw = await client.sendCommand(tokens);
    const serialized = serializeValue(raw);

    if (Array.isArray(serialized)) {
      const rows = serialized.map((item, index) =>
        typeof item === 'object' && item !== null
          ? { index, ...(item as Record<string, unknown>) }
          : { index, value: item }
      );
      return {
        engine: 'redis',
        columns: rows[0] ? Object.keys(rows[0]) : ['value'],
        rows,
        summary: `命令 ${tokens[0].toUpperCase()} 执行成功`,
      };
    }

    if (serialized && typeof serialized === 'object') {
      const rows = Object.entries(serialized as Record<string, unknown>).map(([key, value]) => ({ key, value }));
      return {
        engine: 'redis',
        columns: ['key', 'value'],
        rows,
        summary: `命令 ${tokens[0].toUpperCase()} 执行成功`,
      };
    }

    return {
      engine: 'redis',
      columns: ['value'],
      rows: [{ value: serialized }],
      summary: `命令 ${tokens[0].toUpperCase()} 执行成功`,
    };
  });
}

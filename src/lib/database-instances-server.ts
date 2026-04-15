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
import { resolveMongoConnection, resolveRedisConnection, resolveSqlConnection } from './database-instances';
import { normalizeMongoQueryText } from './mongo-query-compat';

type MySqlConnection = import('mysql2/promise').Connection;
type PgClient = import('pg').Client;
type AppRedisClient = ReturnType<(typeof import('redis'))['createClient']>;
type MongoClient = import('mongodb').MongoClient;
type MongoDb = import('mongodb').Db;
type MongoDocument = Record<string, unknown>;

function isMongoBsonScalar(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && (
      '_bsontype' in (value as Record<string, unknown>)
      || typeof (value as { toHexString?: () => string }).toHexString === 'function'
    );
}

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const preview = value.toString('hex');
    const clipped = preview.length > 32 ? `${preview.slice(0, 32)}…` : preview;
    return `Buffer(${value.length} bytes, hex:${clipped})`;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const preview = buffer.toString('hex');
    const clipped = preview.length > 32 ? `${preview.slice(0, 32)}…` : preview;
    return `Buffer(${buffer.length} bytes, hex:${clipped})`;
  }
  if (Array.isArray(value)) return value.map((item) => serializeValue(item));
  if (isMongoBsonScalar(value)) {
    return value instanceof Date ? value.toISOString() : (value as { toString?: () => string }).toString?.() || JSON.stringify(value);
  }
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

async function withMongo<T>(
  instance: DatabaseInstance | CreateDatabaseInstance,
  fn: (db: MongoDb, client: MongoClient, database: string) => Promise<T>
): Promise<T> {
  const { MongoClient } = await import('mongodb');
  const target = resolveMongoConnection(instance.connectionUri);
  const client = new MongoClient(instance.connectionUri, {
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  try {
    const database = await resolveMongoDatabase(client, target.database);
    const db = client.db(database);
    return await fn(db, client, database);
  } finally {
    await client.close();
  }
}

async function resolveMongoDatabase(client: MongoClient, preferredDatabase?: string): Promise<string> {
  const trimmedPreferred = preferredDatabase?.trim();
  if (trimmedPreferred) {
    return trimmedPreferred;
  }

  const systemDatabases = new Set(['admin', 'local', 'config']);
  try {
    const adminDb = client.db('admin');
    const databaseList = await adminDb.admin().listDatabases();
    const candidateNames = databaseList.databases
      .map((item) => item.name)
      .filter((name) => !systemDatabases.has(name))
      .sort((left, right) => left.localeCompare(right));

    for (const name of candidateNames) {
      try {
        const collections = await client.db(name).listCollections({}, { nameOnly: true }).toArray();
        if (collections.length > 0) {
          return name;
        }
      } catch {
        // Continue probing other databases; the preferred database is not known yet.
      }
    }
  } catch {
    // Fall through to the default admin database when database discovery is unavailable.
  }

  return 'admin';
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
    } else if (input.type === 'mongo') {
      await withMongo(input, async (db) => {
        await db.command({ ping: 1 });
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

interface MongoQueryCommand {
  collection: string;
  operation: 'find' | 'aggregate' | 'count' | 'distinct';
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  field?: string;
  pipeline?: unknown[];
}

function parseMongoQuery(query: string): MongoQueryCommand {
  const normalized = normalizeMongoQueryText(query);
  if (!normalized) {
    throw new Error('请输入 Mongo 查询命令');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error('Mongo 查询请使用 JSON 命令格式');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Mongo 查询命令格式不正确');
  }

  const source = parsed as Record<string, unknown>;
  const collection = typeof source.collection === 'string' ? source.collection.trim() : '';
  const operation = source.operation === 'aggregate' || source.operation === 'count' || source.operation === 'distinct'
    ? source.operation
    : 'find';

  if (!collection) {
    throw new Error('Mongo 查询命令缺少 collection 字段');
  }

  const limit = typeof source.limit === 'number' && Number.isFinite(source.limit) ? Math.max(1, Math.min(Math.trunc(source.limit), 200)) : undefined;
  const skip = typeof source.skip === 'number' && Number.isFinite(source.skip) ? Math.max(0, Math.trunc(source.skip)) : undefined;
  const filter = source.filter && typeof source.filter === 'object' && !Array.isArray(source.filter)
    ? source.filter as Record<string, unknown>
    : {};
  const projection = source.projection && typeof source.projection === 'object' && !Array.isArray(source.projection)
    ? source.projection as Record<string, unknown>
    : undefined;
  const sort = source.sort && typeof source.sort === 'object' && !Array.isArray(source.sort)
    ? source.sort as Record<string, 1 | -1>
    : undefined;
  const field = typeof source.field === 'string' ? source.field.trim() : '';
  const pipeline = Array.isArray(source.pipeline) ? source.pipeline : undefined;

  return {
    collection,
    operation,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(projection && Object.keys(projection).length > 0 ? { projection } : {}),
    ...(sort && Object.keys(sort).length > 0 ? { sort } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(typeof skip === 'number' ? { skip } : {}),
    ...(field ? { field } : {}),
    ...(pipeline && pipeline.length > 0 ? { pipeline } : {}),
  };
}

function ensureMongoQueryIsReadonly(query: string): MongoQueryCommand {
  const command = parseMongoQuery(query);
  if (!['find', 'aggregate', 'count', 'distinct'].includes(command.operation)) {
    throw new Error('当前仅允许执行只读 Mongo 查询命令');
  }
  return command;
}

function buildMongoPreviewRows(rows: MongoDocument[]): Record<string, unknown>[] {
  return rowsToPayloadRows(rows);
}

function inferMongoValueType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    const sample = value.find((item) => item !== null && item !== undefined);
    return `array<${inferMongoValueType(sample)}>`;
  }
  if (value instanceof Date) return 'date';
  if (Buffer.isBuffer(value)) return 'binary';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'number';
  if (typeof value === 'string') return 'string';
  if (value && typeof value === 'object') return 'object';
  return typeof value;
}

function isPlainMongoObject(value: unknown): value is MongoDocument {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !Buffer.isBuffer(value)
    && !isMongoBsonScalar(value);
}

function flattenMongoDocument(
  value: unknown,
  prefix = '',
  depth = 0,
  maxDepth = 2,
  accumulator = new Map<string, { types: Set<string>; samples: unknown[]; nullable: boolean }>()
): Map<string, { types: Set<string>; samples: unknown[]; nullable: boolean }> {
  if (!isPlainMongoObject(value) || depth > maxDepth) {
    return accumulator;
  }

  Object.entries(value).forEach(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isPlainMongoObject(child) && depth < maxDepth) {
      flattenMongoDocument(child, path, depth + 1, maxDepth, accumulator);
      return;
    }

    if (Array.isArray(child) && depth < maxDepth) {
      const entry = accumulator.get(path) || { types: new Set<string>(), samples: [], nullable: false };
      entry.types.add(inferMongoValueType(child));
      entry.nullable = entry.nullable || child.some((item) => item === null || item === undefined);
      entry.samples.push(...child.slice(0, 3));
      accumulator.set(path, entry);
      const firstObject = child.find((item) => isPlainMongoObject(item));
      if (firstObject) {
        flattenMongoDocument(firstObject, `${path}[]`, depth + 1, maxDepth, accumulator);
      }
      return;
    }

    const entry = accumulator.get(path) || { types: new Set<string>(), samples: [], nullable: false };
    entry.types.add(inferMongoValueType(child));
    entry.nullable = entry.nullable || child === null || child === undefined;
    entry.samples.push(child);
    accumulator.set(path, entry);
  });

  return accumulator;
}

function inferMongoColumns(documents: MongoDocument[]): NonNullable<DatabaseCollectionInfo['columns']> {
  const fieldMap = new Map<string, { types: Set<string>; samples: unknown[]; nullable: boolean }>();
  documents.forEach((document) => {
    flattenMongoDocument(document, '', 0, 2, fieldMap);
  });

  return Array.from(fieldMap.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 80)
    .map(([name, meta]) => {
      const sample = meta.samples.find((item) => item !== null && item !== undefined);
      const serializedSample = serializeValue(sample);
      return {
        name,
        type: Array.from(meta.types).sort().join(' | ') || 'unknown',
        nullable: meta.nullable,
        defaultValue: null,
        isPrimary: name === '_id',
        extra: '',
        comment: sample === undefined ? '' : `示例：${typeof serializedSample === 'string' ? serializedSample : JSON.stringify(serializedSample)}`,
      };
    });
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

  if (instance.type === 'mongo') {
    return withMongo(instance, async (db) => {
      const list = await db.listCollections({}, { nameOnly: false }).toArray();
      const collections: DatabaseCollectionInfo[] = [];

      for (const collectionInfo of list) {
        if (collectionInfo.type && collectionInfo.type !== 'collection') {
          continue;
        }

        const collectionName = collectionInfo.name;
        const collection = db.collection(collectionName);
        const [documents, estimatedCount] = await Promise.all([
          collection.find({}).limit(24).toArray(),
          collection.estimatedDocumentCount(),
        ]);
        const columns = inferMongoColumns(documents as MongoDocument[]);
        collections.push({
          name: collectionName,
          category: 'table',
          detail: `${estimatedCount} 条文档 · ${columns.length} 个字段`,
          columns,
        });
      }

      collections.sort((left, right) => left.name.localeCompare(right.name));
      return { engine: 'mongo', collections };
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

  if (instance.type === 'mongo') {
    return withMongo(instance, async (db) => {
      const documents = await db.collection(name).find({}).limit(50).toArray();
      const payloadRows = buildMongoPreviewRows(documents as MongoDocument[]);
      return {
        engine: 'mongo',
        name,
        category: 'table',
        columns: payloadRows[0] ? Object.keys(payloadRows[0]) : [],
        rows: payloadRows,
        summary: `预览 ${name} 集合前 50 条记录`,
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

  if (instance.type === 'mongo') {
    const command = ensureMongoQueryIsReadonly(query);
    return withMongo(instance, async (db) => {
      const collection = db.collection(command.collection);
      const limit = command.limit ? Math.min(command.limit, 200) : 20;
      const skip = command.skip || 0;

      if (command.operation === 'aggregate') {
        const pipeline = Array.isArray(command.pipeline) ? [...command.pipeline] : [];
        if (!pipeline.some((stage) => stage && typeof stage === 'object' && '$limit' in (stage as Record<string, unknown>))) {
          pipeline.push({ $limit: limit });
        }
        const rows = buildMongoPreviewRows(await collection.aggregate(pipeline as never[]).toArray());
        return {
          engine: 'mongo',
          columns: rows[0] ? Object.keys(rows[0]) : [],
          rows,
          summary: `集合 ${command.collection} 聚合返回 ${rows.length} 行`,
        };
      }

      if (command.operation === 'count') {
        const count = await collection.countDocuments(command.filter || {});
        return {
          engine: 'mongo',
          columns: ['count'],
          rows: [{ count }],
          summary: `集合 ${command.collection} 命中 ${count} 条记录`,
        };
      }

      if (command.operation === 'distinct') {
        if (!command.field) {
          throw new Error('distinct 命令缺少 field 字段');
        }
        const values = await collection.distinct(command.field, command.filter || {});
        const rows = values.slice(skip, skip + limit).map((value) => ({ value: serializeValue(value) }));
        return {
          engine: 'mongo',
          columns: ['value'],
          rows,
          summary: `集合 ${command.collection} 的 ${command.field} 去重返回 ${rows.length} 行`,
        };
      }

      const cursor = collection.find(command.filter || {}, {
        projection: command.projection,
        sort: command.sort,
        skip,
        limit,
      });
      const rows = buildMongoPreviewRows(await cursor.toArray());
      return {
        engine: 'mongo',
        columns: rows[0] ? Object.keys(rows[0]) : [],
        rows,
        summary: `集合 ${command.collection} 返回 ${rows.length} 行`,
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

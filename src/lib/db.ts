import Database from 'better-sqlite3';
import path from 'path';
import fs from 'node:fs';
import {
  MockAPI,
  MockAPISummary,
  CreateMockAPI,
  UpdateMockAPI,
  ApiClientConfig,
  ApiClientSummary,
  CreateApiClientConfig,
  UpdateApiClientConfig,
  KeyValuePair,
  ApiForwardConfig,
  ApiForwardSummary,
  CreateApiForwardConfig,
  UpdateApiForwardConfig,
  OrchestrationConfig,
  AIModelProfile,
  AIModelProfileSummary,
  CreateAIModelProfile,
  UpdateAIModelProfile,
  DatabaseInstance,
  DatabaseInstanceSummary,
  CreateDatabaseInstance,
  UpdateDatabaseInstance,
  DbApiConfig,
  DbApiSummary,
  CreateDbApiConfig,
  UpdateDbApiConfig,
} from './types';
import { nanoid } from 'nanoid';
import { sanitizeAIModelProfileInput } from './ai-models';

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');

function resolveDbPath(): string {
  const explicitPath = process.env.SQLITE_DB_PATH?.trim();
  if (explicitPath) {
    return path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(process.cwd(), explicitPath);
  }

  const dataDir = process.env.DATA_DIR?.trim()
    ? (path.isAbsolute(process.env.DATA_DIR.trim())
      ? process.env.DATA_DIR.trim()
      : path.join(process.cwd(), process.env.DATA_DIR.trim()))
    : DEFAULT_DATA_DIR;

  return path.join(dataDir, 'mock-data.db');
}

const DB_PATH = resolveDbPath();

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initializeDb(db);
  }
  return db;
}

function initializeDb(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mock_apis (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      description TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      request_headers TEXT DEFAULT '[]',
      request_params TEXT DEFAULT '[]',
      response_status INTEGER NOT NULL DEFAULT 200,
      response_headers TEXT DEFAULT '[]',
      response_body TEXT DEFAULT '{}',
      response_delay INTEGER NOT NULL DEFAULT 0,
      is_stream INTEGER NOT NULL DEFAULT 0,
      stream_config TEXT DEFAULT '{"chunkDelay":100,"chunks":[]}',
      api_group TEXT DEFAULT '未分组',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration for mock_apis api_group
  try {
    database.exec(`ALTER TABLE mock_apis ADD COLUMN api_group TEXT DEFAULT '未分组';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error mock_apis:', err);
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS api_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      description TEXT DEFAULT '',
      request_headers TEXT DEFAULT '[]',
      request_params TEXT DEFAULT '[]',
      request_body TEXT DEFAULT '{}',
      api_group TEXT DEFAULT '未分组',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration for api_clients api_group
  try {
    database.exec(`ALTER TABLE api_clients ADD COLUMN api_group TEXT DEFAULT '未分组';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error api_clients:', err);
    }
  }

  // Create api_groups table for environment variables implementation
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_groups (
      name TEXT PRIMARY KEY,
      variables TEXT DEFAULT '[]'
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS api_forwards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_group TEXT DEFAULT '未分组',
      description TEXT DEFAULT '',
      method TEXT NOT NULL DEFAULT 'GET',
      path TEXT NOT NULL,
      custom_params TEXT DEFAULT '[]',
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      param_bindings TEXT DEFAULT '[]',
      orchestration TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_model_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'bearer',
      auth_token TEXT DEFAULT '',
      auth_header_name TEXT DEFAULT '',
      model_ids TEXT DEFAULT '[]',
      default_model_id TEXT DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS database_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      connection_uri TEXT NOT NULL,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS db_apis (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_group TEXT DEFAULT '未分组',
      description TEXT DEFAULT '',
      method TEXT NOT NULL DEFAULT 'GET',
      path TEXT NOT NULL,
      custom_params TEXT DEFAULT '[]',
      database_instance_id TEXT NOT NULL,
      sql_template TEXT DEFAULT '',
      param_bindings TEXT DEFAULT '[]',
      redis_config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS nl2data_session_history (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      question TEXT DEFAULT '',
      title TEXT DEFAULT '',
      trigger TEXT NOT NULL,
      sql TEXT NOT NULL,
      summary TEXT DEFAULT '',
      datasource TEXT DEFAULT '',
      engine TEXT NOT NULL,
      columns_json TEXT DEFAULT '[]',
      rows_json TEXT DEFAULT '[]',
      prompt TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration for api_forwards orchestration column
  try {
    database.exec(`ALTER TABLE api_forwards ADD COLUMN orchestration TEXT DEFAULT '{}';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error api_forwards:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE database_instances ADD COLUMN metric_mappings TEXT DEFAULT NULL;`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error database_instances.metric_mappings:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_apis ADD COLUMN redis_config TEXT DEFAULT '{}';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_apis.redis_config:', err);
    }
  }
}

export interface Nl2DataSessionHistoryRecord {
  id: string;
  timestamp: string;
  question: string;
  title: string;
  trigger: 'ai' | 'manual';
  sql: string;
  summary?: string;
  datasource: string;
  engine: 'mysql' | 'pgsql';
  columns: string[];
  rows: Record<string, unknown>[];
  prompt?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToNl2DataSessionHistory(row: Record<string, unknown>): Nl2DataSessionHistoryRecord {
  return {
    id: row.id as string,
    timestamp: row.timestamp as string,
    question: (row.question as string) || '',
    title: (row.title as string) || '',
    trigger: row.trigger === 'manual' ? 'manual' : 'ai',
    sql: (row.sql as string) || '',
    summary: (row.summary as string) || '',
    datasource: (row.datasource as string) || '',
    engine: row.engine === 'pgsql' ? 'pgsql' : 'mysql',
    columns: JSON.parse((row.columns_json as string) || '[]'),
    rows: JSON.parse((row.rows_json as string) || '[]'),
    prompt: (row.prompt as string) || '',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToMockAPI(row: Record<string, unknown>): MockAPI {
  return {
    id: row.id as string,
    name: row.name as string,
    path: row.path as string,
    method: row.method as string,
    description: row.description as string,
    enabled: (row.enabled as number) === 1,
    requestHeaders: JSON.parse(row.request_headers as string),
    requestParams: JSON.parse(row.request_params as string),
    responseStatus: row.response_status as number,
    responseHeaders: JSON.parse(row.response_headers as string),
    responseBody: row.response_body as string,
    responseDelay: row.response_delay as number,
    isStream: (row.is_stream as number) === 1,
    streamConfig: JSON.parse(row.stream_config as string),
    apiGroup: (row.api_group as string) || '未分组',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllMocks(): MockAPI[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM mock_apis ORDER BY created_at DESC').all();
  return rows.map((row) => rowToMockAPI(row as Record<string, unknown>));
}

export function getAllMocksSummary(): MockAPISummary[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, name, path, method, description, enabled, is_stream, response_delay, api_group, created_at, updated_at FROM mock_apis ORDER BY created_at DESC'
  ).all();
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      path: r.path as string,
      method: r.method as string,
      description: (r.description as string) || '',
      enabled: (r.enabled as number) === 1,
      isStream: (r.is_stream as number) === 1,
      responseDelay: r.response_delay as number,
      apiGroup: (r.api_group as string) || '未分组',
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  });
}

export function getMockById(id: string): MockAPI | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mock_apis WHERE id = ?').get(id);
  return row ? rowToMockAPI(row as Record<string, unknown>) : null;
}

export function getEnabledMocks(): MockAPI[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM mock_apis WHERE enabled = 1').all();
  return rows.map((row) => rowToMockAPI(row as Record<string, unknown>));
}

export function createMock(data: CreateMockAPI): MockAPI {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO mock_apis (id, name, path, method, description, enabled,
      request_headers, request_params, response_status, response_headers,
      response_body, response_delay, is_stream, stream_config, api_group, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.path,
    data.method.toUpperCase(),
    data.description || '',
    data.enabled ? 1 : 0,
    JSON.stringify(data.requestHeaders || []),
    JSON.stringify(data.requestParams || []),
    data.responseStatus || 200,
    JSON.stringify(data.responseHeaders || []),
    data.responseBody || '{}',
    data.responseDelay || 0,
    data.isStream ? 1 : 0,
    JSON.stringify(data.streamConfig || { chunkDelay: 100, chunks: [] }),
    data.apiGroup || '未分组',
    now,
    now,
  );

  return getMockById(id)!;
}

export function updateMock(id: string, data: UpdateMockAPI): MockAPI | null {
  const db = getDb();
  const existing = getMockById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
  if (data.path !== undefined) { updates.push('path = ?'); values.push(data.path); }
  if (data.method !== undefined) { updates.push('method = ?'); values.push(data.method.toUpperCase()); }
  if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
  if (data.enabled !== undefined) { updates.push('enabled = ?'); values.push(data.enabled ? 1 : 0); }
  if (data.requestHeaders !== undefined) { updates.push('request_headers = ?'); values.push(JSON.stringify(data.requestHeaders)); }
  if (data.requestParams !== undefined) { updates.push('request_params = ?'); values.push(JSON.stringify(data.requestParams)); }
  if (data.responseStatus !== undefined) { updates.push('response_status = ?'); values.push(data.responseStatus); }
  if (data.responseHeaders !== undefined) { updates.push('response_headers = ?'); values.push(JSON.stringify(data.responseHeaders)); }
  if (data.responseBody !== undefined) { updates.push('response_body = ?'); values.push(data.responseBody); }
  if (data.responseDelay !== undefined) { updates.push('response_delay = ?'); values.push(data.responseDelay); }
  if (data.isStream !== undefined) { updates.push('is_stream = ?'); values.push(data.isStream ? 1 : 0); }
  if (data.streamConfig !== undefined) { updates.push('stream_config = ?'); values.push(JSON.stringify(data.streamConfig)); }
  if (data.apiGroup !== undefined) { updates.push('api_group = ?'); values.push(data.apiGroup); }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE mock_apis SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getMockById(id);
}

export function deleteMock(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM mock_apis WHERE id = ?').run(id);
  return result.changes > 0;
}

export function toggleMock(id: string): MockAPI | null {
  const existing = getMockById(id);
  if (!existing) return null;
  return updateMock(id, { enabled: !existing.enabled });
}

function rowToApiClientConfig(row: Record<string, unknown>): ApiClientConfig {
  return {
    id: row.id as string,
    name: row.name as string,
    url: row.url as string,
    method: row.method as string,
    description: row.description as string,
    requestHeaders: JSON.parse(row.request_headers as string),
    requestParams: JSON.parse(row.request_params as string),
    requestBody: row.request_body as string,
    apiGroup: (row.api_group as string) || '未分组',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllApiClients(): ApiClientConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_clients ORDER BY created_at DESC').all();
  return rows.map((row) => rowToApiClientConfig(row as Record<string, unknown>));
}

export function getAllApiClientsSummary(): ApiClientSummary[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, name, url, method, description, api_group, created_at, updated_at FROM api_clients ORDER BY created_at DESC'
  ).all();
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      url: r.url as string,
      method: r.method as string,
      description: (r.description as string) || '',
      apiGroup: (r.api_group as string) || '未分组',
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  });
}

export function getApiClientById(id: string): ApiClientConfig | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_clients WHERE id = ?').get(id);
  return row ? rowToApiClientConfig(row as Record<string, unknown>) : null;
}

export function createApiClient(data: CreateApiClientConfig): ApiClientConfig {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO api_clients (id, name, url, method, description,
      request_headers, request_params, request_body, api_group, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.url,
    data.method.toUpperCase(),
    data.description || '',
    JSON.stringify(data.requestHeaders || []),
    JSON.stringify(data.requestParams || []),
    data.requestBody || '{}',
    data.apiGroup || '未分组',
    now,
    now,
  );

  return getApiClientById(id)!;
}

export function updateApiClient(id: string, data: UpdateApiClientConfig): ApiClientConfig | null {
  const db = getDb();
  const existing = getApiClientById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
  if (data.url !== undefined) { updates.push('url = ?'); values.push(data.url); }
  if (data.method !== undefined) { updates.push('method = ?'); values.push(data.method.toUpperCase()); }
  if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
  if (data.requestHeaders !== undefined) { updates.push('request_headers = ?'); values.push(JSON.stringify(data.requestHeaders)); }
  if (data.requestParams !== undefined) { updates.push('request_params = ?'); values.push(JSON.stringify(data.requestParams)); }
  if (data.requestBody !== undefined) { updates.push('request_body = ?'); values.push(data.requestBody); }
  if (data.apiGroup !== undefined) { updates.push('api_group = ?'); values.push(data.apiGroup); }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE api_clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getApiClientById(id);
}

export function deleteApiClient(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM api_clients WHERE id = ?').run(id);
  return result.changes > 0;
}

// Group Variables

export function getGroupVariables(name: string): KeyValuePair[] {
  const db = getDb();
  const row = db.prepare('SELECT variables FROM api_groups WHERE name = ?').get(name) as { variables: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.variables);
  } catch {
    return [];
  }
}

export function saveGroupVariables(name: string, variables: KeyValuePair[]): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO api_groups (name, variables)
    VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET variables = excluded.variables
  `).run(name, JSON.stringify(variables));
}

// API Forwards

function rowToApiForwardConfig(row: Record<string, unknown>): ApiForwardConfig {
  let orchestration: OrchestrationConfig | undefined;
  try {
    const parsed = JSON.parse((row.orchestration as string) || '{}');
    if (parsed && parsed.nodes && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
      orchestration = parsed;
    }
  } catch { /* ignore parse errors */ }

  return {
    id: row.id as string,
    name: row.name as string,
    apiGroup: (row.api_group as string) || '未分组',
    description: row.description as string,
    method: row.method as string,
    path: row.path as string,
    customParams: JSON.parse(row.custom_params as string),
    targetType: row.target_type as ApiForwardConfig['targetType'],
    targetId: row.target_id as string,
    paramBindings: JSON.parse(row.param_bindings as string),
    orchestration,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllApiForwards(): ApiForwardConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_forwards ORDER BY created_at DESC').all();
  return rows.map((row) => rowToApiForwardConfig(row as Record<string, unknown>));
}

export function getAllApiForwardsSummary(): ApiForwardSummary[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, name, method, path, api_group, description, created_at, updated_at FROM api_forwards ORDER BY created_at DESC'
  ).all();
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      method: r.method as string,
      path: r.path as string,
      apiGroup: (r.api_group as string) || '未分组',
      description: (r.description as string) || '',
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  });
}

export function getApiForwardById(id: string): ApiForwardConfig | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_forwards WHERE id = ?').get(id);
  return row ? rowToApiForwardConfig(row as Record<string, unknown>) : null;
}

export function createApiForward(data: CreateApiForwardConfig): ApiForwardConfig {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO api_forwards (id, name, api_group, description, method, path,
      custom_params, target_type, target_id, param_bindings, orchestration, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.apiGroup || '未分组',
    data.description || '',
    data.method.toUpperCase(),
    data.path,
    JSON.stringify(data.customParams || []),
    data.targetType,
    data.targetId,
    JSON.stringify(data.paramBindings || []),
    JSON.stringify(data.orchestration || {}),
    now,
    now,
  );

  return getApiForwardById(id)!;
}

export function updateApiForward(id: string, data: UpdateApiForwardConfig): ApiForwardConfig | null {
  const db = getDb();
  const existing = getApiForwardById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name); }
  if (data.apiGroup !== undefined) { updates.push('api_group = ?'); values.push(data.apiGroup); }
  if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description); }
  if (data.method !== undefined) { updates.push('method = ?'); values.push(data.method.toUpperCase()); }
  if (data.path !== undefined) { updates.push('path = ?'); values.push(data.path); }
  if (data.customParams !== undefined) { updates.push('custom_params = ?'); values.push(JSON.stringify(data.customParams)); }
  if (data.targetType !== undefined) { updates.push('target_type = ?'); values.push(data.targetType); }
  if (data.targetId !== undefined) { updates.push('target_id = ?'); values.push(data.targetId); }
  if (data.paramBindings !== undefined) { updates.push('param_bindings = ?'); values.push(JSON.stringify(data.paramBindings)); }
  if (data.orchestration !== undefined) { updates.push('orchestration = ?'); values.push(JSON.stringify(data.orchestration)); }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE api_forwards SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getApiForwardById(id);
}

export function deleteApiForward(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM api_forwards WHERE id = ?').run(id);
  return result.changes > 0;
}

function rowToDbApiConfig(row: Record<string, unknown>): DbApiConfig {
  return {
    id: row.id as string,
    name: row.name as string,
    apiGroup: (row.api_group as string) || '未分组',
    description: (row.description as string) || '',
    method: row.method as string,
    path: row.path as string,
    customParams: JSON.parse((row.custom_params as string) || '[]'),
    databaseInstanceId: row.database_instance_id as string,
    sqlTemplate: (row.sql_template as string) || '',
    paramBindings: JSON.parse((row.param_bindings as string) || '[]'),
    redisConfig: JSON.parse((row.redis_config as string) || '{}'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllDbApis(): DbApiConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM db_apis ORDER BY created_at DESC').all();
  return rows.map((row) => rowToDbApiConfig(row as Record<string, unknown>));
}

export function getAllDbApisSummary(): DbApiSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, api_group, description, method, path, database_instance_id, created_at, updated_at
    FROM db_apis
    ORDER BY created_at DESC
  `).all();

  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: record.id as string,
      name: record.name as string,
      apiGroup: (record.api_group as string) || '未分组',
      description: (record.description as string) || '',
      method: record.method as string,
      path: record.path as string,
      databaseInstanceId: record.database_instance_id as string,
      createdAt: record.created_at as string,
      updatedAt: record.updated_at as string,
    };
  });
}

export function getDbApiById(id: string): DbApiConfig | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM db_apis WHERE id = ?').get(id);
  return row ? rowToDbApiConfig(row as Record<string, unknown>) : null;
}

export function createDbApi(input: CreateDbApiConfig): DbApiConfig {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO db_apis (
      id, name, api_group, description, method, path, custom_params,
      database_instance_id, sql_template, param_bindings, redis_config, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.apiGroup || '未分组',
    input.description || '',
    input.method.toUpperCase(),
    input.path,
    JSON.stringify(input.customParams || []),
    input.databaseInstanceId,
    input.sqlTemplate || '',
    JSON.stringify(input.paramBindings || []),
    JSON.stringify(input.redisConfig || { enabled: false }),
    now,
    now
  );

  return getDbApiById(id)!;
}

export function updateDbApi(id: string, input: UpdateDbApiConfig): DbApiConfig | null {
  const db = getDb();
  const existing = getDbApiById(id);
  if (!existing) return null;

  const next = {
    ...existing,
    ...input,
  };
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE db_apis
    SET
      name = ?,
      api_group = ?,
      description = ?,
      method = ?,
      path = ?,
      custom_params = ?,
      database_instance_id = ?,
      sql_template = ?,
      param_bindings = ?,
      redis_config = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    next.name,
    next.apiGroup || '未分组',
    next.description || '',
    next.method.toUpperCase(),
    next.path,
    JSON.stringify(next.customParams || []),
    next.databaseInstanceId,
    next.sqlTemplate || '',
    JSON.stringify(next.paramBindings || []),
    JSON.stringify(next.redisConfig || { enabled: false }),
    now,
    id
  );

  return getDbApiById(id);
}

export function deleteDbApi(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM db_apis WHERE id = ?').run(id);
  return result.changes > 0;
}

function rowToAIModelProfile(row: Record<string, unknown>): AIModelProfile {
  return {
    id: row.id as string,
    name: row.name as string,
    baseUrl: row.base_url as string,
    authType: row.auth_type as AIModelProfile['authType'],
    authToken: (row.auth_token as string) || '',
    authHeaderName: (row.auth_header_name as string) || '',
    modelIds: JSON.parse((row.model_ids as string) || '[]'),
    defaultModelId: (row.default_model_id as string) || '',
    isDefault: (row.is_default as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllAIModelProfiles(): AIModelProfile[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM ai_model_profiles
    ORDER BY is_default DESC, updated_at DESC, created_at DESC
  `).all();

  return rows.map((row) => rowToAIModelProfile(row as Record<string, unknown>));
}

export function getAllAIModelProfilesSummary(): AIModelProfileSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, base_url, auth_type, model_ids, default_model_id, is_default, created_at, updated_at
    FROM ai_model_profiles
    ORDER BY is_default DESC, updated_at DESC, created_at DESC
  `).all();

  return rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    authType: row.auth_type,
    modelIds: JSON.parse((row.model_ids as string) || '[]'),
    defaultModelId: (row.default_model_id as string) || '',
    isDefault: (row.is_default as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export function getAIModelProfileById(id: string): AIModelProfile | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_model_profiles WHERE id = ?').get(id);
  return row ? rowToAIModelProfile(row as Record<string, unknown>) : null;
}

export function createAIModelProfile(input: CreateAIModelProfile): AIModelProfile {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();
  const data = sanitizeAIModelProfileInput(input);

  const tx = db.transaction(() => {
    if (data.isDefault) {
      db.prepare('UPDATE ai_model_profiles SET is_default = 0').run();
    }

    db.prepare(`
      INSERT INTO ai_model_profiles (
        id, name, base_url, auth_type, auth_token, auth_header_name,
        model_ids, default_model_id, is_default, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.baseUrl,
      data.authType,
      data.authToken || '',
      data.authHeaderName || '',
      JSON.stringify(data.modelIds),
      data.defaultModelId,
      data.isDefault ? 1 : 0,
      now,
      now
    );
  });

  tx();
  return getAIModelProfileById(id)!;
}

export function updateAIModelProfile(id: string, input: UpdateAIModelProfile): AIModelProfile | null {
  const db = getDb();
  const existing = getAIModelProfileById(id);
  if (!existing) return null;

  const data = sanitizeAIModelProfileInput({
    ...existing,
    ...input,
    modelIds: input.modelIds ?? existing.modelIds,
    defaultModelId: input.defaultModelId ?? existing.defaultModelId,
    authType: input.authType ?? existing.authType,
    authToken: input.authToken ?? existing.authToken,
    authHeaderName: input.authHeaderName ?? existing.authHeaderName,
  });
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    if (data.isDefault) {
      db.prepare('UPDATE ai_model_profiles SET is_default = 0 WHERE id != ?').run(id);
    }

    db.prepare(`
      UPDATE ai_model_profiles
      SET
        name = ?,
        base_url = ?,
        auth_type = ?,
        auth_token = ?,
        auth_header_name = ?,
        model_ids = ?,
        default_model_id = ?,
        is_default = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      data.name,
      data.baseUrl,
      data.authType,
      data.authToken || '',
      data.authHeaderName || '',
      JSON.stringify(data.modelIds),
      data.defaultModelId,
      data.isDefault ? 1 : 0,
      now,
      id
    );
  });

  tx();
  return getAIModelProfileById(id);
}

export function deleteAIModelProfile(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM ai_model_profiles WHERE id = ?').run(id);
  return result.changes > 0;
}

function rowToDatabaseInstance(row: Record<string, unknown>): DatabaseInstance {
  let metricMappings: DatabaseInstance['metricMappings'];
  try {
    if (row.metric_mappings) {
      metricMappings = JSON.parse(row.metric_mappings as string) as DatabaseInstance['metricMappings'];
    }
  } catch {
    metricMappings = undefined;
  }

  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as DatabaseInstance['type'],
    connectionUri: row.connection_uri as string,
    username: (row.username as string) || '',
    password: (row.password as string) || '',
    metricMappings,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllDatabaseInstances(): DatabaseInstance[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM database_instances
    ORDER BY updated_at DESC, created_at DESC
  `).all();
  return rows.map((row) => rowToDatabaseInstance(row as Record<string, unknown>));
}

export function getAllDatabaseInstancesSummary(): DatabaseInstanceSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, type, connection_uri, created_at, updated_at
    FROM database_instances
    ORDER BY updated_at DESC, created_at DESC
  `).all();

  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: record.id as string,
      name: record.name as string,
      type: record.type as DatabaseInstanceSummary['type'],
      connectionUri: record.connection_uri as string,
      createdAt: record.created_at as string,
      updatedAt: record.updated_at as string,
    };
  });
}

export function getDatabaseInstanceById(id: string): DatabaseInstance | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM database_instances WHERE id = ?').get(id);
  return row ? rowToDatabaseInstance(row as Record<string, unknown>) : null;
}

export function createDatabaseInstance(input: CreateDatabaseInstance): DatabaseInstance {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO database_instances (
      id, name, type, connection_uri, username, password, metric_mappings, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.type,
    input.connectionUri,
    input.username || '',
    input.password || '',
    input.metricMappings ? JSON.stringify(input.metricMappings) : null,
    now,
    now
  );

  return getDatabaseInstanceById(id)!;
}

export function updateDatabaseInstance(id: string, input: UpdateDatabaseInstance): DatabaseInstance | null {
  const db = getDb();
  const existing = getDatabaseInstanceById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const next = {
    ...existing,
    ...input,
  };

  db.prepare(`
    UPDATE database_instances
    SET
      name = ?,
      type = ?,
      connection_uri = ?,
      username = ?,
      password = ?,
      metric_mappings = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    next.name,
    next.type,
    next.connectionUri,
    next.username || '',
    next.password || '',
    next.metricMappings ? JSON.stringify(next.metricMappings) : null,
    now,
    id
  );

  return getDatabaseInstanceById(id);
}

export function updateDatabaseInstanceMetricMappings(id: string, metricMappings: DatabaseInstance['metricMappings']): DatabaseInstance | null {
  const db = getDb();
  const existing = getDatabaseInstanceById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE database_instances
    SET
      metric_mappings = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    metricMappings ? JSON.stringify(metricMappings) : null,
    now,
    id
  );

  return getDatabaseInstanceById(id);
}

export function deleteDatabaseInstance(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM database_instances WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getNl2DataSessionHistory(limit = 24): Nl2DataSessionHistoryRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM nl2data_session_history
    ORDER BY timestamp DESC, created_at DESC
    LIMIT ?
  `).all(limit);

  return rows.map((row) => rowToNl2DataSessionHistory(row as Record<string, unknown>));
}

export function createNl2DataSessionHistory(
  input: Omit<Nl2DataSessionHistoryRecord, 'createdAt' | 'updatedAt'>
): Nl2DataSessionHistoryRecord {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO nl2data_session_history (
      id,
      timestamp,
      question,
      title,
      trigger,
      sql,
      summary,
      datasource,
      engine,
      columns_json,
      rows_json,
      prompt,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.timestamp,
    input.question || '',
    input.title || '',
    input.trigger,
    input.sql,
    input.summary || '',
    input.datasource || '',
    input.engine,
    JSON.stringify(input.columns || []),
    JSON.stringify(input.rows || []),
    input.prompt || '',
    now,
    now
  );

  return getNl2DataSessionHistory(1).find((item) => item.id === input.id)!;
}

export function deleteNl2DataSessionHistory(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM nl2data_session_history WHERE id = ?').run(id);
  return result.changes > 0;
}

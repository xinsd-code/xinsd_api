import Database from 'better-sqlite3';
import path from 'path';
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
} from './types';
import { nanoid } from 'nanoid';
import { sanitizeAIModelProfileInput } from './ai-models';

const DB_PATH = path.join(process.cwd(), 'mock-data.db');

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
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
      request_body TEXT DEFAULT '{}',
      response_status INTEGER NOT NULL DEFAULT 200,
      response_headers TEXT DEFAULT '[]',
      response_body TEXT DEFAULT '{}',
      response_delay INTEGER NOT NULL DEFAULT 0,
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

  try {
    database.exec(`ALTER TABLE mock_apis ADD COLUMN request_body TEXT DEFAULT '{}';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error mock_apis request_body:', err);
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

  // Migration for api_forwards orchestration column
  try {
    database.exec(`ALTER TABLE api_forwards ADD COLUMN orchestration TEXT DEFAULT '{}';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error api_forwards:', err);
    }
  }

  // Migration for api_forwards redis_config column
  try {
    database.exec(`ALTER TABLE api_forwards ADD COLUMN redis_config TEXT DEFAULT NULL;`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error api_forwards redis_config:', err);
    }
  }
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
    requestBody: (row.request_body as string) || '{}',
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
      request_headers, request_params, request_body, response_status, response_headers,
      response_body, response_delay, is_stream, stream_config, api_group, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name,
    data.path,
    data.method.toUpperCase(),
    data.description || '',
    data.enabled ? 1 : 0,
    JSON.stringify(data.requestHeaders || []),
    JSON.stringify(data.requestParams || []),
    data.requestBody || '{}',
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
  if (data.requestBody !== undefined) { updates.push('request_body = ?'); values.push(data.requestBody); }
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

  let redisConfig: any;
  try {
    if (row.redis_config) {
      redisConfig = JSON.parse(row.redis_config as string);
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
    targetType: row.target_type as 'mock' | 'api-client',
    targetId: row.target_id as string,
    paramBindings: JSON.parse(row.param_bindings as string),
    orchestration,
    redisConfig,
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
      custom_params, target_type, target_id, param_bindings, orchestration, redis_config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    data.redisConfig ? JSON.stringify(data.redisConfig) : null,
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
  if (data.redisConfig !== undefined) { updates.push('redis_config = ?'); values.push(data.redisConfig ? JSON.stringify(data.redisConfig) : null); }

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
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as DatabaseInstance['type'],
    connectionUri: row.connection_uri as string,
    username: (row.username as string) || '',
    password: (row.password as string) || '',
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

  return rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    connectionUri: row.connection_uri,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
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
      id, name, type, connection_uri, username, password, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.type,
    input.connectionUri,
    input.username || '',
    input.password || '',
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
      updated_at = ?
    WHERE id = ?
  `).run(
    next.name,
    next.type,
    next.connectionUri,
    next.username || '',
    next.password || '',
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

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
  DatabaseSemanticModel,
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
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from './database-instances';
import type {
  DBHarnessAgentTelemetry,
  DBHarnessChatMessage,
  DBHarnessGepaCandidate,
  DBHarnessGepaRun,
  DBHarnessGepaRunStatus,
  DBHarnessGepaSampleResult,
  DBHarnessGepaScoreCard,
  DBHarnessFeedbackCorrectionRule,
  DBHarnessKnowledgeMemoryEntry,
  DBHarnessPromptTemplateRecord,
  DBHarnessQueryMetricRecord,
  DBHarnessRuntimeConfig,
  DBHarnessSelectedModelInput,
  DBHarnessSessionRecord,
  DBHarnessWorkspaceRecord,
  DBMultiAgentRole,
} from './db-harness/core/types';
import {
  redactSensitiveText,
  sanitizeKnowledgePayloadForStorage,
  sanitizeMetricStorageInput,
  sanitizePromptTemplateInput,
} from './db-harness/core/redaction';
import { invalidateWorkspaceContextCache } from './db-harness/workspace/workspace-cache';

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
      model_type TEXT NOT NULL DEFAULT 'chat',
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
      owner_id TEXT DEFAULT 'default-user',
      workspace_id TEXT DEFAULT 'default-workspace',
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

  database.exec(`
    CREATE TABLE IF NOT EXISTS db_harness_workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      database_id TEXT DEFAULT '',
      rules TEXT DEFAULT '',
      runtime_config_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS db_harness_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      messages_json TEXT DEFAULT '[]',
      selected_database_id TEXT DEFAULT '',
      selected_model_profile_id TEXT DEFAULT '',
      selected_model_id TEXT DEFAULT '',
      last_message_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS db_harness_knowledge_memory (
      id TEXT PRIMARY KEY,
      memory_key TEXT NOT NULL,
      workspace_id TEXT DEFAULT '',
      database_id TEXT DEFAULT '',
      session_id TEXT DEFAULT '',
      message_id TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'feedback',
      feedback_type TEXT DEFAULT '',
      summary TEXT NOT NULL,
      tags_json TEXT DEFAULT '[]',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS db_harness_query_metrics (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT DEFAULT '',
      database_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      question TEXT NOT NULL,
      question_hash TEXT NOT NULL,
      sql TEXT NOT NULL DEFAULT '',
      query_fingerprint TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      from_cache INTEGER NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL DEFAULT 0,
      agent_telemetry_json TEXT DEFAULT '{}',
      labels_json TEXT DEFAULT '[]',
      error_message TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS db_harness_prompt_templates (
      id TEXT PRIMARY KEY,
      template_key TEXT NOT NULL UNIQUE,
      workspace_id TEXT DEFAULT '',
      database_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'feedback',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt_patch TEXT NOT NULL DEFAULT '',
      compression_level TEXT DEFAULT '',
      ner_candidate_limit INTEGER DEFAULT NULL,
      question_hash TEXT DEFAULT '',
      query_fingerprint TEXT DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      labels_json TEXT DEFAULT '[]',
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS db_harness_gepa_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT DEFAULT '',
      database_id TEXT NOT NULL,
      sample_limit INTEGER NOT NULL DEFAULT 20,
      dataset_version TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      candidate_set_json TEXT DEFAULT '[]',
      sample_results_json TEXT DEFAULT '[]',
      score_card_json TEXT DEFAULT '{}',
      report_json TEXT DEFAULT '{}',
      approved_at TEXT DEFAULT '',
      approved_by TEXT DEFAULT '',
      applied_at TEXT DEFAULT '',
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
    database.exec(`ALTER TABLE ai_model_profiles ADD COLUMN model_type TEXT NOT NULL DEFAULT 'chat';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error ai_model_profiles model_type:', err);
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
    database.exec(`ALTER TABLE database_instances ADD COLUMN semantic_model TEXT DEFAULT NULL;`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error database_instances.semantic_model:', err);
    }
  }

  // Migration for database_instances owner_id and workspace_id (existing tables)
  try {
    database.exec(`ALTER TABLE database_instances ADD COLUMN owner_id TEXT DEFAULT 'default-user';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error database_instances.owner_id:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE database_instances ADD COLUMN workspace_id TEXT DEFAULT 'default-workspace';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error database_instances.workspace_id:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_apis ADD COLUMN redis_config TEXT DEFAULT '{}';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_apis.redis_config:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_harness_workspaces ADD COLUMN database_id TEXT DEFAULT '';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_harness_workspaces.database_id:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_harness_workspaces ADD COLUMN rules TEXT DEFAULT '';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_harness_workspaces.rules:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_harness_workspaces ADD COLUMN runtime_config_json TEXT DEFAULT '{}';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_harness_workspaces.runtime_config_json:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_harness_query_metrics ADD COLUMN agent_telemetry_json TEXT DEFAULT '{}';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_harness_query_metrics.agent_telemetry_json:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_harness_query_metrics ADD COLUMN labels_json TEXT DEFAULT '[]';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_harness_query_metrics.labels_json:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_harness_prompt_templates ADD COLUMN source TEXT NOT NULL DEFAULT 'feedback';`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_harness_prompt_templates.source:', err);
    }
  }

  try {
    database.exec(`ALTER TABLE db_harness_prompt_templates ADD COLUMN confidence REAL NOT NULL DEFAULT 0;`);
  } catch (err) {
    if (err instanceof Error && !err.message.includes('duplicate column name')) {
      console.error('Migration error db_harness_prompt_templates.confidence:', err);
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

function parseJsonArray<T>(value: unknown, fallback: T[] = []): T[] {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject<T>(value: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function rowToDBHarnessSession(row: Record<string, unknown>): DBHarnessSessionRecord {
  const profileId = typeof row.selected_model_profile_id === 'string' ? row.selected_model_profile_id : '';
  const modelId = typeof row.selected_model_id === 'string' ? row.selected_model_id : '';
  const selectedModel: DBHarnessSelectedModelInput | null = profileId && modelId
    ? { profileId, modelId }
    : null;

  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    title: (row.title as string) || '新会话',
    messages: parseJsonArray<DBHarnessChatMessage>(row.messages_json),
    selectedDatabaseId: (row.selected_database_id as string) || '',
    selectedModel,
    lastMessageAt: (row.last_message_at as string) || (row.updated_at as string) || (row.created_at as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function bumpDBHarnessWorkspace(workspaceId: string, nextTimestamp?: string) {
  const db = getDb();
  db.prepare(`
    UPDATE db_harness_workspaces
    SET updated_at = ?
    WHERE id = ?
  `).run(nextTimestamp || new Date().toISOString(), workspaceId);
  invalidateWorkspaceContextCache({ workspaceId });
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

function rowToDBHarnessWorkspace(row: Record<string, unknown>, sessions: DBHarnessSessionRecord[] = []): DBHarnessWorkspaceRecord {
  return {
    id: row.id as string,
    name: (row.name as string) || '新建 Workspace',
    databaseId: (row.database_id as string) || '',
    rules: (row.rules as string) || '',
    runtimeConfig: parseJsonObject<DBHarnessRuntimeConfig>(row.runtime_config_json, {}),
    sessions,
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
    modelType: row.model_type === 'embedding' ? 'embedding' : 'chat',
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
    ORDER BY model_type ASC, is_default DESC, updated_at DESC, created_at DESC
  `).all();

  return rows.map((row) => rowToAIModelProfile(row as Record<string, unknown>));
}

export function getAllAIModelProfilesSummary(): AIModelProfileSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, model_type, base_url, auth_type, model_ids, default_model_id, is_default, created_at, updated_at
    FROM ai_model_profiles
    ORDER BY model_type ASC, is_default DESC, updated_at DESC, created_at DESC
  `).all();

  return rows.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      id: item.id as string,
      name: item.name as string,
      modelType: item.model_type === 'embedding' ? 'embedding' : 'chat',
      baseUrl: item.base_url as string,
      authType: item.auth_type as AIModelProfile['authType'],
      modelIds: JSON.parse((item.model_ids as string) || '[]'),
      defaultModelId: (item.default_model_id as string) || '',
      isDefault: (item.is_default as number) === 1,
      createdAt: item.created_at as string,
      updatedAt: item.updated_at as string,
    };
  });
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
      db.prepare('UPDATE ai_model_profiles SET is_default = 0 WHERE model_type = ?').run(data.modelType);
    }

    db.prepare(`
      INSERT INTO ai_model_profiles (
        id, name, model_type, base_url, auth_type, auth_token, auth_header_name,
        model_ids, default_model_id, is_default, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.modelType,
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
      db.prepare('UPDATE ai_model_profiles SET is_default = 0 WHERE id != ? AND model_type = ?').run(id, data.modelType);
    }

    db.prepare(`
      UPDATE ai_model_profiles
      SET
        name = ?,
        model_type = ?,
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
      data.modelType,
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
  let semanticModel: DatabaseSemanticModel | undefined;
  try {
    if (row.metric_mappings) {
      metricMappings = JSON.parse(row.metric_mappings as string) as DatabaseInstance['metricMappings'];
    }
  } catch {
    metricMappings = undefined;
  }

  try {
    if (row.semantic_model) {
      semanticModel = JSON.parse(row.semantic_model as string) as DatabaseSemanticModel;
    }
  } catch {
    semanticModel = undefined;
  }

  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as DatabaseInstance['type'],
    connectionUri: row.connection_uri as string,
    username: (row.username as string) || '',
    password: (row.password as string) || '',
    ownerId: (row.owner_id as string) || 'default-user',
    workspaceId: (row.workspace_id as string) || 'default-workspace',
    metricMappings,
    semanticModel,
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
    SELECT id, name, type, connection_uri, owner_id, workspace_id, metric_mappings, semantic_model, created_at, updated_at
    FROM database_instances
    ORDER BY updated_at DESC, created_at DESC
  `).all();

  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    let metricMappings: DatabaseInstance['metricMappings'];
    let semanticModel: DatabaseSemanticModel | undefined;
    try {
      if (record.metric_mappings) {
        metricMappings = JSON.parse(record.metric_mappings as string) as DatabaseInstance['metricMappings'];
      }
    } catch { /* ignore */ }
    try {
      if (record.semantic_model) {
        semanticModel = JSON.parse(record.semantic_model as string) as DatabaseSemanticModel;
      }
    } catch { /* ignore */ }
    return {
      id: record.id as string,
      name: record.name as string,
      type: record.type as DatabaseInstanceSummary['type'],
      connectionUri: record.connection_uri as string,
      ownerId: (record.owner_id as string) || 'default-user',
      workspaceId: (record.workspace_id as string) || 'default-workspace',
      metricMappings,
      semanticModel,
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
  const semanticModel = sanitizeDatabaseSemanticModel(input.semanticModel);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: input.metricMappings,
    semanticModel,
  });

  db.prepare(`
    INSERT INTO database_instances (
      id, name, type, connection_uri, username, password, owner_id, workspace_id, metric_mappings, semantic_model, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.type,
    input.connectionUri,
    input.username || '',
    input.password || '',
    input.ownerId || 'default-user',
    input.workspaceId || 'default-workspace',
    Object.keys(metricMappings).length > 0 ? JSON.stringify(metricMappings) : null,
    semanticModel ? JSON.stringify(semanticModel) : null,
    now,
    now
  );

  invalidateWorkspaceContextCache({ databaseId: id });
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
  const semanticModel = sanitizeDatabaseSemanticModel(next.semanticModel);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: next.metricMappings,
    semanticModel,
  });

  db.prepare(`
    UPDATE database_instances
    SET
      name = ?,
      type = ?,
      connection_uri = ?,
      username = ?,
      password = ?,
      metric_mappings = ?,
      semantic_model = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    next.name,
    next.type,
    next.connectionUri,
    next.username || '',
    next.password || '',
    Object.keys(metricMappings).length > 0 ? JSON.stringify(metricMappings) : null,
    semanticModel ? JSON.stringify(semanticModel) : null,
    now,
    id
  );

  invalidateWorkspaceContextCache({ databaseId: id });
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

  invalidateWorkspaceContextCache({ databaseId: id });
  return getDatabaseInstanceById(id);
}

export function updateDatabaseInstanceSemanticModel(id: string, semanticModel: DatabaseInstance['semanticModel']): DatabaseInstance | null {
  const db = getDb();
  const existing = getDatabaseInstanceById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const sanitizedSemanticModel = sanitizeDatabaseSemanticModel(semanticModel);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: existing.metricMappings,
    semanticModel: sanitizedSemanticModel,
  });
  db.prepare(`
    UPDATE database_instances
    SET
      metric_mappings = ?,
      semantic_model = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    Object.keys(metricMappings).length > 0 ? JSON.stringify(metricMappings) : null,
    sanitizedSemanticModel ? JSON.stringify(sanitizedSemanticModel) : null,
    now,
    id
  );

  invalidateWorkspaceContextCache({ databaseId: id });
  return getDatabaseInstanceById(id);
}

export function deleteDatabaseInstance(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM database_instances WHERE id = ?').run(id);
  if (result.changes > 0) {
    invalidateWorkspaceContextCache({ databaseId: id });
  }
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

export function getDBHarnessWorkspaces(): DBHarnessWorkspaceRecord[] {
  const db = getDb();
  const workspaceRows = db.prepare(`
    SELECT *
    FROM db_harness_workspaces
    ORDER BY updated_at DESC, created_at DESC
  `).all();

  const sessionRows = db.prepare(`
    SELECT *
    FROM db_harness_sessions
    ORDER BY last_message_at DESC, created_at DESC
  `).all();

  const sessionsByWorkspace = new Map<string, DBHarnessSessionRecord[]>();
  sessionRows.forEach((row) => {
    const session = rowToDBHarnessSession(row as Record<string, unknown>);
    const bucket = sessionsByWorkspace.get(session.workspaceId) || [];
    bucket.push(session);
    sessionsByWorkspace.set(session.workspaceId, bucket);
  });

  return workspaceRows.map((row) => rowToDBHarnessWorkspace(row as Record<string, unknown>, sessionsByWorkspace.get((row as Record<string, unknown>).id as string) || []));
}

export function getDBHarnessWorkspaceById(id: string): DBHarnessWorkspaceRecord | null {
  const db = getDb();
  const workspaceRow = db.prepare(`
    SELECT *
    FROM db_harness_workspaces
    WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!workspaceRow) {
    return null;
  }

  const sessionRows = db.prepare(`
    SELECT *
    FROM db_harness_sessions
    WHERE workspace_id = ?
    ORDER BY last_message_at DESC, created_at DESC
  `).all(id);
  const sessions = sessionRows.map((row) => rowToDBHarnessSession(row as Record<string, unknown>));
  return rowToDBHarnessWorkspace(workspaceRow, sessions);
}

export function createDBHarnessWorkspace(input: { id?: string; name: string; databaseId?: string; rules?: string; runtimeConfig?: DBHarnessRuntimeConfig }): DBHarnessWorkspaceRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id || nanoid();
  const databaseId = input.databaseId?.trim() || '';
  const rules = input.rules?.trim() || '';
  const runtimeConfig = input.runtimeConfig || {};

  db.prepare(`
    INSERT INTO db_harness_workspaces (
      id,
      name,
      database_id,
      rules,
      runtime_config_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name.trim() || '新建 Workspace', databaseId, rules, JSON.stringify(runtimeConfig), now, now);

  invalidateWorkspaceContextCache({ workspaceId: id, databaseId });
  return {
    id,
    name: input.name.trim() || '新建 Workspace',
    databaseId,
    rules,
    runtimeConfig,
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updateDBHarnessWorkspace(input: { id: string; name?: string; databaseId?: string; rules?: string; runtimeConfig?: DBHarnessRuntimeConfig }): DBHarnessWorkspaceRecord | null {
  const db = getDb();
  const current = db.prepare(`
    SELECT *
    FROM db_harness_workspaces
    WHERE id = ?
  `).get(input.id) as Record<string, unknown> | undefined;

  if (!current) {
    return null;
  }

  const now = new Date().toISOString();
  const nextName = input.name === undefined ? ((current.name as string) || '新建 Workspace') : (input.name.trim() || '新建 Workspace');
  const nextDatabaseId = input.databaseId === undefined ? (((current.database_id as string) || '')) : input.databaseId.trim();
  const nextRules = input.rules === undefined ? (((current.rules as string) || '')) : input.rules.trim();
  const nextRuntimeConfig = input.runtimeConfig === undefined
    ? parseJsonObject<DBHarnessRuntimeConfig>(current.runtime_config_json, {})
    : input.runtimeConfig;
  db.prepare(`
    UPDATE db_harness_workspaces
    SET name = ?,
        database_id = ?,
        rules = ?,
        runtime_config_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(nextName, nextDatabaseId, nextRules, JSON.stringify(nextRuntimeConfig || {}), now, input.id);

  invalidateWorkspaceContextCache({ workspaceId: input.id, databaseId: nextDatabaseId });
  const sessions = getDBHarnessWorkspaces().find((item) => item.id === input.id)?.sessions || [];
  return {
    id: input.id,
    name: nextName,
    databaseId: nextDatabaseId,
    rules: nextRules,
    runtimeConfig: nextRuntimeConfig,
    sessions,
    createdAt: current.created_at as string,
    updatedAt: now,
  };
}

export function deleteDBHarnessWorkspace(id: string): boolean {
  const db = getDb();
  const deleteKnowledge = db.prepare('DELETE FROM db_harness_knowledge_memory WHERE workspace_id = ?');
  const deleteMetrics = db.prepare('DELETE FROM db_harness_query_metrics WHERE workspace_id = ?');
  const deleteTemplates = db.prepare('DELETE FROM db_harness_prompt_templates WHERE workspace_id = ?');
  const deleteGepaRuns = db.prepare('DELETE FROM db_harness_gepa_runs WHERE workspace_id = ?');
  const deleteSessions = db.prepare('DELETE FROM db_harness_sessions WHERE workspace_id = ?');
  const deleteWorkspace = db.prepare('DELETE FROM db_harness_workspaces WHERE id = ?');
  const tx = db.transaction((workspaceId: string) => {
    deleteKnowledge.run(workspaceId);
    deleteMetrics.run(workspaceId);
    deleteTemplates.run(workspaceId);
    deleteGepaRuns.run(workspaceId);
    deleteSessions.run(workspaceId);
    return deleteWorkspace.run(workspaceId);
  });

  const result = tx(id);
  if (result.changes > 0) {
    invalidateWorkspaceContextCache({ workspaceId: id });
  }
  return result.changes > 0;
}

export function createDBHarnessSession(input: {
  id?: string;
  workspaceId: string;
  title?: string;
  messages?: DBHarnessChatMessage[];
  selectedDatabaseId?: string;
  selectedModel?: DBHarnessSelectedModelInput | null;
  lastMessageAt?: string;
}): DBHarnessSessionRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id || nanoid();
  const title = input.title?.trim() || '新会话';
  const lastMessageAt = input.lastMessageAt || now;

  db.prepare(`
    INSERT INTO db_harness_sessions (
      id,
      workspace_id,
      title,
      messages_json,
      selected_database_id,
      selected_model_profile_id,
      selected_model_id,
      last_message_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.workspaceId,
    title,
    JSON.stringify(input.messages || []),
    input.selectedDatabaseId || '',
    input.selectedModel?.profileId || '',
    input.selectedModel?.modelId || '',
    lastMessageAt,
    now,
    now
  );

  bumpDBHarnessWorkspace(input.workspaceId, lastMessageAt);

  return {
    id,
    workspaceId: input.workspaceId,
    title,
    messages: input.messages || [],
    selectedDatabaseId: input.selectedDatabaseId || '',
    selectedModel: input.selectedModel || null,
    lastMessageAt,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateDBHarnessSession(input: {
  id: string;
  title?: string;
  messages?: DBHarnessChatMessage[];
  selectedDatabaseId?: string;
  selectedModel?: DBHarnessSelectedModelInput | null;
  lastMessageAt?: string;
}): DBHarnessSessionRecord | null {
  const db = getDb();
  const current = db.prepare(`
    SELECT *
    FROM db_harness_sessions
    WHERE id = ?
  `).get(input.id) as Record<string, unknown> | undefined;

  if (!current) {
    return null;
  }

  const now = new Date().toISOString();
  const nextTitle = input.title?.trim() || (current.title as string) || '新会话';
  const nextMessages = Array.isArray(input.messages) ? input.messages : parseJsonArray<DBHarnessChatMessage>(current.messages_json);
  const nextSelectedDatabaseId = input.selectedDatabaseId ?? ((current.selected_database_id as string) || '');
  const existingProfileId = (current.selected_model_profile_id as string) || '';
  const existingModelId = (current.selected_model_id as string) || '';
  const nextSelectedModel = input.selectedModel === undefined
    ? (existingProfileId && existingModelId ? { profileId: existingProfileId, modelId: existingModelId } : null)
    : input.selectedModel;
  const lastMessageAt = input.lastMessageAt || (nextMessages[nextMessages.length - 1]?.createdAt ?? (current.last_message_at as string) ?? now);

  db.prepare(`
    UPDATE db_harness_sessions
    SET title = ?,
        messages_json = ?,
        selected_database_id = ?,
        selected_model_profile_id = ?,
        selected_model_id = ?,
        last_message_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    nextTitle,
    JSON.stringify(nextMessages),
    nextSelectedDatabaseId,
    nextSelectedModel?.profileId || '',
    nextSelectedModel?.modelId || '',
    lastMessageAt,
    now,
    input.id
  );

  bumpDBHarnessWorkspace(current.workspace_id as string, lastMessageAt);

  return {
    id: input.id,
    workspaceId: current.workspace_id as string,
    title: nextTitle,
    messages: nextMessages,
    selectedDatabaseId: nextSelectedDatabaseId,
    selectedModel: nextSelectedModel,
    lastMessageAt,
    createdAt: current.created_at as string,
    updatedAt: now,
  };
}

export function deleteDBHarnessSession(id: string): boolean {
  const db = getDb();
  const current = db.prepare(`
    SELECT workspace_id
    FROM db_harness_sessions
    WHERE id = ?
  `).get(id) as { workspace_id?: string } | undefined;

  if (!current?.workspace_id) {
    return false;
  }

  const result = db.prepare('DELETE FROM db_harness_sessions WHERE id = ?').run(id);
  if (result.changes > 0) {
    bumpDBHarnessWorkspace(current.workspace_id);
  }
  return result.changes > 0;
}

function rowToDBHarnessKnowledgeMemoryEntry(row: Record<string, unknown>): DBHarnessKnowledgeMemoryEntry {
  const payload = parseJsonObject<Record<string, unknown>>(row.payload_json, {});
  const correctionRule = payload.correctionRule && typeof payload.correctionRule === 'object' && !Array.isArray(payload.correctionRule)
    ? (payload.correctionRule as DBHarnessFeedbackCorrectionRule)
    : undefined;
  return {
    key: (row.memory_key as string) || '',
    summary: (row.summary as string) || '',
    tags: parseJsonArray<string>(row.tags_json).slice(0, 24),
    source: row.source === 'schema' ? 'schema' : 'feedback',
    feedbackType: row.feedback_type === 'corrective' ? 'corrective' : row.feedback_type === 'positive' ? 'positive' : undefined,
    updatedAt: (row.updated_at as string) || undefined,
    correctionRule,
    payload,
  };
}

function rowToDBHarnessPromptTemplateRecord(row: Record<string, unknown>): DBHarnessPromptTemplateRecord {
  return {
    id: (row.id as string) || '',
    templateKey: (row.template_key as string) || '',
    workspaceId: (row.workspace_id as string) || '',
    databaseId: (row.database_id as string) || '',
    source: row.source === 'gepa' ? 'gepa' : 'feedback',
    title: (row.title as string) || '',
    description: (row.description as string) || '',
    promptPatch: (row.prompt_patch as string) || '',
    compressionLevel: row.compression_level === 'standard' || row.compression_level === 'compact' || row.compression_level === 'minimal'
      ? row.compression_level
      : undefined,
    nerCandidateLimit: row.ner_candidate_limit === null || row.ner_candidate_limit === undefined
      ? undefined
      : Number(row.ner_candidate_limit),
    questionHash: (row.question_hash as string) || undefined,
    queryFingerprint: (row.query_fingerprint as string) || undefined,
    confidence: Number(row.confidence || 0),
    labels: parseJsonArray<string>(row.labels_json).slice(0, 24),
    usageCount: Number(row.usage_count || 0),
    lastUsedAt: (row.last_used_at as string) || undefined,
    createdAt: (row.created_at as string) || '',
    updatedAt: (row.updated_at as string) || '',
  };
}

function rowToDBHarnessQueryMetricRecord(row: Record<string, unknown>): DBHarnessQueryMetricRecord {
  const agentTelemetry = parseJsonObject<Partial<Record<DBMultiAgentRole, DBHarnessAgentTelemetry>>>(row.agent_telemetry_json, {});
  return {
    id: row.id as string,
    turnId: row.turn_id as string,
    workspaceId: (row.workspace_id as string) || '',
    databaseId: (row.database_id as string) || '',
    engine: (row.engine as DBHarnessQueryMetricRecord['engine']) || 'mysql',
    question: (row.question as string) || '',
    questionHash: (row.question_hash as string) || '',
    sql: (row.sql as string) || '',
    queryFingerprint: (row.query_fingerprint as string) || '',
    outcome: (row.outcome as DBHarnessQueryMetricRecord['outcome']) || 'error',
    confidence: Number(row.confidence || 0),
    fromCache: Number(row.from_cache || 0) > 0,
    rowCount: Number(row.row_count || 0),
    agentTelemetry,
    labels: parseJsonArray<string>(row.labels_json).slice(0, 24),
    errorMessage: (row.error_message as string) || undefined,
    createdAt: (row.created_at as string) || '',
    updatedAt: (row.updated_at as string) || '',
  };
}

export function listDBHarnessKnowledgeMemory(input: {
  workspaceId?: string;
  databaseId?: string;
  limit?: number;
}): DBHarnessKnowledgeMemoryEntry[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(input.limit ?? 24, 120));
  const databaseId = input.databaseId?.trim() || '';
  const workspaceId = input.workspaceId?.trim() || '';

  const rows = db.prepare(`
    SELECT *
    FROM db_harness_knowledge_memory
    WHERE (? = '' OR database_id = ?)
      AND (? = '' OR workspace_id = ? OR workspace_id = '')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(databaseId, databaseId, workspaceId, workspaceId, limit);

  return rows.map((row) => rowToDBHarnessKnowledgeMemoryEntry(row as Record<string, unknown>));
}

export function upsertDBHarnessKnowledgeMemory(input: {
  key: string;
  workspaceId?: string;
  databaseId: string;
  sessionId?: string;
  messageId?: string;
  source?: 'feedback' | 'schema';
  feedbackType?: 'positive' | 'corrective';
  summary: string;
  tags: string[];
  payload?: Record<string, unknown>;
}): DBHarnessKnowledgeMemoryEntry {
  const db = getDb();
  const now = new Date().toISOString();
  const key = redactSensitiveText(input.key.trim());
  const summary = redactSensitiveText(input.summary.trim());
  const tags = input.tags
    .map((item) => redactSensitiveText(item))
    .filter((item, index, array) => item.trim() && array.indexOf(item) === index)
    .slice(0, 24);
  const payload = sanitizeKnowledgePayloadForStorage(input.payload || {});

  if (!key || !summary || !input.databaseId.trim()) {
    throw new Error('知识记忆缺少必要字段。');
  }

  const current = input.messageId
    ? db.prepare(`
      SELECT *
      FROM db_harness_knowledge_memory
      WHERE message_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(input.messageId)
    : undefined;

  const id = current
    ? ((current as Record<string, unknown>).id as string)
    : nanoid();

  db.prepare(`
    INSERT OR REPLACE INTO db_harness_knowledge_memory (
      id,
      memory_key,
      workspace_id,
      database_id,
      session_id,
      message_id,
      source,
      feedback_type,
      summary,
      tags_json,
      payload_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    key,
    input.workspaceId?.trim() || '',
    input.databaseId.trim(),
    input.sessionId?.trim() || '',
    input.messageId?.trim() || '',
    input.source || 'feedback',
    input.feedbackType || '',
    summary,
    JSON.stringify(tags),
    JSON.stringify(payload),
    current ? ((current as Record<string, unknown>).created_at as string) || now : now,
    now
  );

  invalidateWorkspaceContextCache({ workspaceId: input.workspaceId, databaseId: input.databaseId });
  const row = db.prepare(`
    SELECT *
    FROM db_harness_knowledge_memory
    WHERE id = ?
  `).get(id);

  return rowToDBHarnessKnowledgeMemoryEntry(row as Record<string, unknown>);
}

export function listDBHarnessQueryMetrics(input: {
  workspaceId?: string;
  databaseId?: string;
  limit?: number;
}): DBHarnessQueryMetricRecord[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(input.limit ?? 24, 120));
  const databaseId = input.databaseId?.trim() || '';
  const workspaceId = input.workspaceId?.trim() || '';
  const rows = db.prepare(`
    SELECT *
    FROM db_harness_query_metrics
    WHERE (? = '' OR database_id = ?)
      AND (? = '' OR workspace_id = ? OR workspace_id = '')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(databaseId, databaseId, workspaceId, workspaceId, limit);

  return rows.map((row) => rowToDBHarnessQueryMetricRecord(row as Record<string, unknown>));
}

export function listDBHarnessPromptTemplates(input: {
  workspaceId?: string;
  databaseId?: string;
  limit?: number;
}): DBHarnessPromptTemplateRecord[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(input.limit ?? 24, 120));
  const databaseId = input.databaseId?.trim() || '';
  const workspaceId = input.workspaceId?.trim() || '';
  const rows = db.prepare(`
    SELECT *
    FROM db_harness_prompt_templates
    WHERE (? = '' OR database_id = ?)
      AND (? = '' OR workspace_id = ? OR workspace_id = '')
    ORDER BY confidence DESC, usage_count DESC, updated_at DESC, created_at DESC
    LIMIT ?
  `).all(databaseId, databaseId, workspaceId, workspaceId, limit);

  return rows.map((row) => rowToDBHarnessPromptTemplateRecord(row as Record<string, unknown>));
}

export function upsertDBHarnessPromptTemplate(input: {
  id?: string;
  templateKey: string;
  workspaceId?: string;
  databaseId: string;
  source?: 'feedback' | 'gepa';
  title: string;
  description: string;
  promptPatch: string;
  compressionLevel?: 'standard' | 'compact' | 'minimal';
  nerCandidateLimit?: number;
  questionHash?: string;
  queryFingerprint?: string;
  confidence?: number;
  labels?: string[];
  usageCount?: number;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}): DBHarnessPromptTemplateRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const current = db.prepare(`
    SELECT *
    FROM db_harness_prompt_templates
    WHERE template_key = ?
    LIMIT 1
  `).get(input.templateKey) as Record<string, unknown> | undefined;

  const id = input.id || ((current?.id as string) || nanoid());
  const createdAt = input.createdAt || ((current?.created_at as string) || now);
  const sanitizedTemplate = sanitizePromptTemplateInput({
    title: input.title,
    description: input.description,
    promptPatch: input.promptPatch,
    labels: input.labels,
  });
  const labels = sanitizedTemplate.labels
    .filter((item, index, array) => item.trim() && array.findIndex((value) => value === item) === index)
    .slice(0, 24);

  db.prepare(`
    INSERT OR REPLACE INTO db_harness_prompt_templates (
      id,
      template_key,
      workspace_id,
      database_id,
      source,
      title,
      description,
      prompt_patch,
      compression_level,
      ner_candidate_limit,
      question_hash,
      query_fingerprint,
      confidence,
      labels_json,
      usage_count,
      last_used_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    redactSensitiveText(input.templateKey),
    input.workspaceId?.trim() || '',
    input.databaseId.trim(),
    input.source || 'feedback',
    sanitizedTemplate.title.trim() || 'DB Harness 模板',
    sanitizedTemplate.description.trim() || '',
    sanitizedTemplate.promptPatch.trim() || '',
    input.compressionLevel || '',
    Number.isFinite(input.nerCandidateLimit) ? Math.max(8, Math.min(Math.trunc(input.nerCandidateLimit || 0), 32)) : null,
    input.questionHash?.trim() || '',
    input.queryFingerprint?.trim() || '',
    Number.isFinite(input.confidence) ? Number(input.confidence) : 0,
    JSON.stringify(labels),
    Math.max(0, Math.trunc(input.usageCount || 0)),
    input.lastUsedAt || (current?.last_used_at as string) || '',
    createdAt,
    input.updatedAt || now
  );

  const row = db.prepare(`
    SELECT *
    FROM db_harness_prompt_templates
    WHERE id = ?
  `).get(id);

  return rowToDBHarnessPromptTemplateRecord(row as Record<string, unknown>);
}

export function upsertDBHarnessQueryMetric(input: Omit<DBHarnessQueryMetricRecord, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<DBHarnessQueryMetricRecord, 'id' | 'createdAt' | 'updatedAt'>>): DBHarnessQueryMetricRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id || nanoid();
  const createdAt = input.createdAt || now;
  const sanitizedMetric = sanitizeMetricStorageInput({
    question: input.question,
    sql: input.sql,
    errorMessage: input.errorMessage,
    labels: input.labels,
  });

  db.prepare(`
    INSERT OR REPLACE INTO db_harness_query_metrics (
      id,
      turn_id,
      workspace_id,
      database_id,
      engine,
      question,
      question_hash,
      sql,
      query_fingerprint,
      outcome,
      confidence,
      from_cache,
      row_count,
      agent_telemetry_json,
      labels_json,
      error_message,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.turnId,
    input.workspaceId?.trim() || '',
    input.databaseId.trim(),
    input.engine,
    sanitizedMetric.question,
    input.questionHash,
    sanitizedMetric.sql,
    input.queryFingerprint,
    input.outcome,
    Number.isFinite(input.confidence) ? input.confidence : 0,
    input.fromCache ? 1 : 0,
    Math.max(0, Math.trunc(input.rowCount || 0)),
    JSON.stringify(input.agentTelemetry || {}),
    JSON.stringify(sanitizedMetric.labels),
    sanitizedMetric.errorMessage || '',
    createdAt,
    now
  );

  const row = db.prepare(`
    SELECT *
    FROM db_harness_query_metrics
    WHERE turn_id = ?
  `).get(input.turnId);

  return rowToDBHarnessQueryMetricRecord(row as Record<string, unknown>);
}

function rowToDBHarnessGepaRun(row: Record<string, unknown>): DBHarnessGepaRun {
  return {
    id: row.id as string,
    workspaceId: (row.workspace_id as string) || '',
    databaseId: (row.database_id as string) || '',
    sampleLimit: Number(row.sample_limit || 20),
    datasetVersion: (row.dataset_version as string) || '',
    status: (row.status as DBHarnessGepaRunStatus) || 'draft',
    candidateSet: parseJsonArray<DBHarnessGepaCandidate>(row.candidate_set_json),
    samples: parseJsonArray<DBHarnessGepaSampleResult>(row.sample_results_json),
    scoreCard: parseJsonObject<DBHarnessGepaScoreCard>(row.score_card_json, {
      sqlSuccessRate: 0,
      emptyRate: 0,
      latencyAvgMs: 0,
      latencyP95Ms: 0,
      tokenCost: 0,
      balancedScore: 0,
      notes: [],
    }),
    report: parseJsonObject<Record<string, unknown>>(row.report_json, {}),
    approvedAt: (row.approved_at as string) || undefined,
    approvedBy: (row.approved_by as string) || undefined,
    appliedAt: (row.applied_at as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function listDBHarnessGepaRuns(limit = 24): DBHarnessGepaRun[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT *
    FROM db_harness_gepa_runs
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 100)));
  return rows.map((row) => rowToDBHarnessGepaRun(row as Record<string, unknown>));
}

export function getDBHarnessGepaRunById(id: string): DBHarnessGepaRun | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM db_harness_gepa_runs
    WHERE id = ?
  `).get(id);
  return row ? rowToDBHarnessGepaRun(row as Record<string, unknown>) : null;
}

export function createDBHarnessGepaRun(input: {
  workspaceId?: string;
  databaseId: string;
  sampleLimit?: number;
  datasetVersion?: string;
  candidateSet?: DBHarnessGepaCandidate[];
  samples?: DBHarnessGepaSampleResult[];
  scoreCard?: DBHarnessGepaScoreCard;
  report?: Record<string, unknown>;
  status?: DBHarnessGepaRunStatus;
  approvedAt?: string;
  approvedBy?: string;
  appliedAt?: string;
}): DBHarnessGepaRun {
  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO db_harness_gepa_runs (
      id,
      workspace_id,
      database_id,
      sample_limit,
      dataset_version,
      status,
      candidate_set_json,
      sample_results_json,
      score_card_json,
      report_json,
      approved_at,
      approved_by,
      applied_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.workspaceId?.trim() || '',
    input.databaseId.trim(),
    Math.max(1, Math.trunc(input.sampleLimit || 20)),
    input.datasetVersion || '',
    input.status || 'draft',
    JSON.stringify(input.candidateSet || []),
    JSON.stringify(input.samples || []),
    JSON.stringify(input.scoreCard || {
      sqlSuccessRate: 0,
      emptyRate: 0,
      latencyAvgMs: 0,
      latencyP95Ms: 0,
      tokenCost: 0,
      balancedScore: 0,
      notes: [],
    }),
    JSON.stringify(input.report || {}),
    input.approvedAt || '',
    input.approvedBy || '',
    input.appliedAt || '',
    now,
    now
  );

  return getDBHarnessGepaRunById(id)!;
}

export function updateDBHarnessGepaRun(id: string, input: Partial<{
  workspaceId: string;
  databaseId: string;
  sampleLimit: number;
  datasetVersion: string;
  candidateSet: DBHarnessGepaCandidate[];
  samples: DBHarnessGepaSampleResult[];
  scoreCard: DBHarnessGepaScoreCard;
  report: Record<string, unknown>;
  status: DBHarnessGepaRunStatus;
  approvedAt: string;
  approvedBy: string;
  appliedAt: string;
}>): DBHarnessGepaRun | null {
  const current = getDBHarnessGepaRunById(id);
  if (!current) return null;

  const next = {
    ...current,
    ...input,
  };
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    UPDATE db_harness_gepa_runs
    SET workspace_id = ?,
        database_id = ?,
        sample_limit = ?,
        dataset_version = ?,
        status = ?,
        candidate_set_json = ?,
        sample_results_json = ?,
        score_card_json = ?,
        report_json = ?,
        approved_at = ?,
        approved_by = ?,
        applied_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    next.workspaceId || '',
    next.databaseId,
    Math.max(1, Math.trunc(next.sampleLimit || 20)),
    next.datasetVersion || '',
    next.status,
    JSON.stringify(next.candidateSet || []),
    JSON.stringify(next.samples || []),
    JSON.stringify(next.scoreCard || current.scoreCard),
    JSON.stringify(next.report || current.report),
    next.approvedAt || '',
    next.approvedBy || '',
    next.appliedAt || '',
    now,
    id
  );

  return getDBHarnessGepaRunById(id);
}

export function deleteDBHarnessGepaRun(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM db_harness_gepa_runs WHERE id = ?').run(id);
  if (result.changes > 0) {
    getDBHarnessWorkspaces().forEach((workspace) => {
      if (workspace.runtimeConfig?.appliedRunId !== id) {
        return;
      }
      updateDBHarnessWorkspace({
        id: workspace.id,
        runtimeConfig: {
          ...workspace.runtimeConfig,
          appliedRunId: undefined,
          appliedCandidateIds: undefined,
        },
      });
    });
  }
  return result.changes > 0;
}

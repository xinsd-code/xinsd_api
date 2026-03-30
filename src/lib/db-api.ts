import {
  CreateDbApiConfig,
  CustomParamDef,
  DatabaseQueryPayload,
  DatabaseInstance,
  DbApiConfig,
  SqlVariableBinding,
} from './types';
import { matchPath } from './matcher';
import { executeParameterizedDatabaseQuery } from './database-instances-server';
import { flattenJsonBody } from './json-body';
import { normalizeSqlForExecution } from './sql-normalize';
import { SQL_VARIABLE_PATTERN } from './sql-template';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface CompiledSqlTemplate {
  sql: string;
  values: unknown[];
  previewSql: string;
  resolvedBindings: Array<{ variableKey: string; source: string; value: unknown }>;
}

function normalizePreviewLimit(value?: number | null): number | null {
  if (!Number.isFinite(value) || !value) return null;
  const next = Math.trunc(Number(value));
  if (next <= 0) return null;
  return Math.min(next, 100);
}

function trimTrailingSemicolon(value: string): string {
  return value.trim().replace(/;+\s*$/, '');
}

function trimLeadingWithClause(value: string): string {
  return value.trim().replace(/^with\b/i, '');
}

function buildPreviewSummary(rowCount: number, previewLimit: number): string {
  return rowCount >= previewLimit
    ? `预览已截断，展示前 ${previewLimit} 行`
    : `共返回 ${rowCount} 行`;
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function quoteSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) {
    return `(${value.map((item) => quoteSqlLiteral(item)).join(', ')})`;
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${raw.replace(/'/g, "''")}'`;
}

function coerceInputValue(param: CustomParamDef | undefined, value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (!param) {
    return value;
  }

  if (param.type === 'integer') {
    const next = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isNaN(next) ? null : next;
  }

  if (param.type === 'number') {
    const next = typeof value === 'number' ? value : Number(String(value));
    return Number.isNaN(next) ? null : next;
  }

  if (param.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'on'].includes(normalized);
  }

  if (param.type === 'array') {
    if (Array.isArray(value)) return value;
    const raw = String(value).trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return raw.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }

  return typeof value === 'string' ? value : stringifyScalar(value);
}

export function sanitizeDbApiInput(input: Partial<CreateDbApiConfig>): CreateDbApiConfig {
  return {
    name: input.name?.trim() || '',
    apiGroup: input.apiGroup?.trim() || '未分组',
    description: input.description?.trim() || '',
    method: (input.method || 'GET').toUpperCase(),
    path: input.path?.trim() || '',
    customParams: Array.isArray(input.customParams) ? input.customParams : [],
    databaseInstanceId: input.databaseInstanceId?.trim() || '',
    sqlTemplate: input.sqlTemplate || '',
    paramBindings: Array.isArray(input.paramBindings) ? input.paramBindings : [],
    redisConfig: input.redisConfig,
  };
}

export function validateDbApiInput(input: CreateDbApiConfig): string | null {
  if (!input.name) return '请输入 DB API 名称';
  if (!input.path) return '请输入接口路径';
  if (!input.path.startsWith('/')) return '接口路径需以 / 开头';
  if (!ALLOWED_METHODS.has(input.method)) return '暂不支持当前请求方法';
  if (!input.databaseInstanceId) return '请选择数据库数据源';
  return null;
}

export function buildRequestInputMap(
  pathParams: Record<string, string>,
  queryParams: URLSearchParams,
  body: unknown
): Record<string, unknown> {
  const inputMap: Record<string, unknown> = { ...pathParams };

  queryParams.forEach((value, key) => {
    inputMap[key] = value;
  });

  if (body && typeof body === 'object') {
    Object.entries(body as Record<string, unknown>).forEach(([key, value]) => {
      inputMap[key] = value;
    });

    const flattened = flattenJsonBody(body);
    flattened.forEach((field) => {
      inputMap[field.path] = field.value;
      inputMap[`$.${field.path}`] = field.value;
    });
  }

  return inputMap;
}

export function findMatchingDbApi(
  dbApis: DbApiConfig[],
  method: string,
  requestPath: string
): { config: DbApiConfig; pathParams: Record<string, string> } | null {
  for (const config of dbApis) {
    if (config.method !== method.toUpperCase() && config.method !== '*') {
      continue;
    }

    const pathResult = matchPath(config.path, requestPath);
    if (!pathResult.matched) {
      continue;
    }

    return {
      config,
      pathParams: pathResult.params,
    };
  }

  return null;
}

function resolveBindingValue(
  variableKey: string,
  bindings: SqlVariableBinding[],
  customParams: CustomParamDef[],
  inputValues: Record<string, unknown>
): { source: string; value: unknown } {
  const binding = bindings.find((item) => item.variableKey === variableKey);
  if (!binding) {
    const directParam = customParams.find((item) => item.key === variableKey);
    const directValue = inputValues[variableKey] ?? directParam?.defaultValue;
    return {
      source: directParam ? `入参 ${directParam.key}` : `变量 ${variableKey}`,
      value: coerceInputValue(directParam, directValue),
    };
  }

  if (binding.staticValue !== undefined) {
    return {
      source: '固定静态值',
      value: binding.staticValue,
    };
  }

  const customParam = customParams.find((item) => item.key === binding.customParamKey);
  const rawValue = binding.customParamKey
    ? inputValues[binding.customParamKey] ?? inputValues[variableKey] ?? customParam?.defaultValue
    : inputValues[variableKey];
  return {
    source: binding.customParamKey ? `入参 ${binding.customParamKey}` : `变量 ${variableKey}`,
    value: coerceInputValue(customParam, rawValue),
  };
}

export function compileDbApiSql(
  instance: DatabaseInstance,
  config: Pick<DbApiConfig, 'sqlTemplate' | 'paramBindings' | 'customParams'>,
  inputValues: Record<string, unknown>
): CompiledSqlTemplate {
  let placeholderIndex = 0;
  const values: unknown[] = [];
  const resolvedBindings: CompiledSqlTemplate['resolvedBindings'] = [];

  const sql = config.sqlTemplate.replace(SQL_VARIABLE_PATTERN, (_full, rawVariableKey: string) => {
    const variableKey = String(rawVariableKey).trim();
    const resolved = resolveBindingValue(variableKey, config.paramBindings || [], config.customParams || [], inputValues);
    placeholderIndex += 1;
    values.push(resolved.value ?? null);
    resolvedBindings.push({
      variableKey,
      source: resolved.source,
      value: resolved.value ?? null,
    });

    if (instance.type === 'pgsql') {
      return `$${placeholderIndex}`;
    }
    return '?';
  });

  let previewSql = sql;
  if (instance.type === 'pgsql') {
    resolvedBindings.forEach((binding, index) => {
      previewSql = previewSql.replace(new RegExp(`\\$${index + 1}(?!\\d)`, 'g'), quoteSqlLiteral(binding.value));
    });
  } else {
    let previewIndex = 0;
    previewSql = sql.replace(/\?/g, () => {
      const binding = resolvedBindings[previewIndex];
      previewIndex += 1;
      return quoteSqlLiteral(binding?.value);
    });
  }

  return {
    sql,
    values,
    previewSql,
    resolvedBindings,
  };
}

export async function executeDbApi(
  config: DbApiConfig,
  instance: DatabaseInstance,
  inputValues: Record<string, unknown>,
  options?: { previewLimit?: number | null }
) {
  const compiled = compileDbApiSql(instance, config, inputValues);
  const normalizedSql = normalizeSqlForExecution(instance.type, compiled.sql);
  const normalizedPreviewSql = normalizeSqlForExecution(instance.type, compiled.previewSql);
  const previewLimit = normalizePreviewLimit(options?.previewLimit);
  const baseSql = trimTrailingSemicolon(normalizedSql);
  const basePreviewSql = trimTrailingSemicolon(normalizedPreviewSql);
  const executableSql = previewLimit
    ? `SELECT * FROM (${baseSql}) AS __db_api_preview LIMIT ${previewLimit}`
    : normalizedSql;
  const previewSql = previewLimit
    ? `SELECT * FROM (${basePreviewSql}) AS __db_api_preview LIMIT ${previewLimit}`
    : normalizedPreviewSql;
  let result: DatabaseQueryPayload;
  let usedFallbackPreview = false;

  try {
    result = await executeParameterizedDatabaseQuery(instance, executableSql, compiled.values);
  } catch (error) {
    if (!previewLimit) {
      throw error;
    }
    const rawResult = await executeParameterizedDatabaseQuery(instance, normalizedSql, compiled.values);
    result = {
      ...rawResult,
      rows: rawResult.rows.slice(0, previewLimit),
      summary: buildPreviewSummary(rawResult.rows.length, previewLimit),
    };
    usedFallbackPreview = true;
  }

  if (previewLimit && result.rows.length === 0) {
    const shouldFallback = /^with\b/i.test(baseSql) || /\{\{/.test(config.sqlTemplate) || trimLeadingWithClause(config.sqlTemplate) !== config.sqlTemplate;
    if (shouldFallback) {
      try {
        const rawResult = await executeParameterizedDatabaseQuery(instance, normalizedSql, compiled.values);
        result = {
          ...rawResult,
          rows: rawResult.rows.slice(0, previewLimit),
          summary: buildPreviewSummary(rawResult.rows.length, previewLimit),
        };
        usedFallbackPreview = true;
      } catch {
        // Keep the wrapped preview result when the fallback query also fails.
      }
    }
  }

  return {
    result,
    debug: {
      engine: instance.type,
      datasource: instance.name,
      sql: executableSql,
      previewSql,
      values: compiled.values,
      resolvedBindings: compiled.resolvedBindings,
      previewLimit,
      usedFallbackPreview,
    },
  };
}

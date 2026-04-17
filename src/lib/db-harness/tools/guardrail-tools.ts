import { executeParameterizedDatabaseQuery } from '@/lib/database-instances-server';
import { normalizeSqlForExecution } from '@/lib/sql-normalize';
import { DatabaseInstanceType, DatabaseSchemaPayload } from '@/lib/types';
import { normalizeMongoQueryText } from '@/lib/mongo-query-compat';
import { DBHarnessExecutionPayload, DBHarnessQueryPlan, DBHarnessWorkspaceContext } from '../core/types';

function isMongoCommandQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const source = parsed as Record<string, unknown>;
    return Boolean(
      'collection' in source
      || 'find' in source
      || 'aggregate' in source
      || 'count' in source
      || 'distinct' in source
      || source.operation === 'find'
      || source.operation === 'aggregate'
      || source.operation === 'count'
      || source.operation === 'distinct'
    );
  } catch {
    return false;
  }
}

function assertMongoReadOnlyGuardrails(
  query: string
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw new Error('当前回合未通过 Guardrail Agent 校验：Mongo 查询必须使用 JSON 命令。');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：Mongo 查询命令格式不正确。');
  }

  const source = parsed as Record<string, unknown>;
  const operation = typeof source.operation === 'string'
    ? source.operation
    : typeof source.find === 'string'
      ? 'find'
      : typeof source.aggregate === 'object'
        ? 'aggregate'
        : typeof source.count === 'string'
          ? 'count'
          : typeof source.distinct === 'string'
            ? 'distinct'
            : 'find';
  if (!['find', 'aggregate', 'count', 'distinct'].includes(operation)) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：Mongo 查询只能使用只读操作。');
  }

  const collection = typeof source.collection === 'string'
    ? source.collection
    : typeof source.find === 'string'
      ? source.find
      : typeof source.aggregate === 'string'
        ? source.aggregate
        : typeof source.count === 'string'
          ? source.count
          : typeof source.distinct === 'string'
            ? source.distinct
            : '';
  if (!collection) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：Mongo 查询缺少 collection。');
  }
}

export function assertReadOnlyGuardrails(
  sql: string
) {
  const normalizedMongoSql = normalizeMongoQueryText(sql);
  if (isMongoCommandQuery(normalizedMongoSql)) {
    assertMongoReadOnlyGuardrails(normalizedMongoSql);
    return;
  }

  const normalized = sql.trim();
  if (!/^(select|with|show|desc|describe|explain)\b/i.test(normalized)) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：仅允许执行只读 SQL。');
  }
  if (/(--|\/\*)/.test(normalized)) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：SQL 不能包含注释。');
  }

  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(normalized)) {
    throw new Error('当前回合未通过 Guardrail Agent 校验：SQL 包含危险关键字。');
  }
}

function buildPreviewSummary(rowCount: number, previewLimit: number): string {
  return rowCount >= previewLimit
    ? `预览已截断，展示前 ${previewLimit} 行`
    : `共返回 ${rowCount} 行`;
}

function buildColumnLookup(schema: DatabaseSchemaPayload) {
  const tableMap = new Map<string, Set<string>>();
  schema.collections
    .filter((collection) => collection.category === 'table')
    .forEach((collection) => {
      tableMap.set(
        collection.name,
        new Set((collection.columns || []).map((column) => column.name))
      );
    });
  return tableMap;
}

function isMongoSpecialColumn(schema: DatabaseSchemaPayload, column: string) {
  return schema.engine === 'mongo' && column === '_id';
}

export function assertPlanResolvable(
  plan: DBHarnessQueryPlan,
  schema: DatabaseSchemaPayload
) {
  const tableMap = buildColumnLookup(schema);

  const checkField = (table: string | undefined, column: string | undefined, label: string) => {
    if (!table || !column || column === '*') return;
    const tableColumns = tableMap.get(table);
    if (!tableColumns) {
      throw new Error(`当前回合已中止：${label} 引用了不存在的数据表 ${table}。`);
    }
    if (!tableColumns.has(column) && !isMongoSpecialColumn(schema, column)) {
      throw new Error(`当前回合已中止：${label} 引用了不存在的字段 ${table}.${column}。`);
    }
  };

  if (plan.targetTable && !tableMap.has(plan.targetTable)) {
    throw new Error(`当前回合已中止：查询计划指向了不存在的数据表 ${plan.targetTable}。`);
  }

  plan.dimensions.forEach((dimension) => checkField(dimension.table, dimension.column, '维度'));
  plan.metrics.forEach((metric) => checkField(metric.table, metric.column, '指标'));
  plan.filters.forEach((filter) => checkField(filter.table, filter.column, '筛选条件'));

  if (
    !plan.targetTable
    && plan.dimensions.length === 0
    && plan.metrics.length === 0
    && plan.filters.length === 0
  ) {
    throw new Error('当前回合已中止：查询计划没有映射到任何可执行的数据字段。');
  }
}

export async function executeReadOnlyPlan(
  plan: DBHarnessQueryPlan,
  workspace: DBHarnessWorkspaceContext
): Promise<DBHarnessExecutionPayload> {
  const previewLimit = Math.min(Math.max(plan.limit || 20, 1), 200);
  const engine = workspace.databaseInstance.type as DatabaseInstanceType;
  const normalizedSql = engine === 'mongo'
    ? normalizeMongoQueryText(plan.compiled.text)
    : normalizeSqlForExecution(engine, plan.compiled.text);
  const previewSql = plan.compiled.previewSql || normalizedSql;
  let result;

  try {
    if (engine === 'mongo') {
      result = await executeParameterizedDatabaseQuery(
        workspace.databaseInstance,
        normalizedSql,
        plan.compiled.values
      );
    } else {
      const wrappedSql = `SELECT * FROM (${normalizedSql.replace(/;+\s*$/, '')}) AS __db_harness_preview LIMIT ${previewLimit}`;
      result = await executeParameterizedDatabaseQuery(
        workspace.databaseInstance,
        wrappedSql,
        plan.compiled.values
      );
    }
  } catch {
    const rawResult = await executeParameterizedDatabaseQuery(
      workspace.databaseInstance,
      normalizedSql,
      plan.compiled.values
    );
    result = engine === 'mongo'
      ? rawResult
      : {
          ...rawResult,
          rows: rawResult.rows.slice(0, previewLimit),
          summary: buildPreviewSummary(rawResult.rows.length, previewLimit),
        };
  }

  return {
    sql: normalizedSql,
    columns: result.columns,
    rows: result.rows,
    summary: result.summary,
    datasource: workspace.databaseInstance.name,
    engine,
    previewSql,
  };
}

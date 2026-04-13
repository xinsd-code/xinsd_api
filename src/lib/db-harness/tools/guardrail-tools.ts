import { executeParameterizedDatabaseQuery } from '@/lib/database-instances-server';
import { normalizeSqlForExecution } from '@/lib/sql-normalize';
import { DatabaseSchemaPayload } from '@/lib/types';
import { DatabaseMetricViewMap, DBHarnessExecutionPayload, DBHarnessQueryPlan, DBHarnessWorkspaceContext } from '../core/types';

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /email/i,
  /phone/i,
  /mobile/i,
  /身份证/,
  /手机号/,
  /id[_-]?card/i,
  /ssn/i,
];

function extractSensitiveColumns(
  sql: string,
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap
): string[] {
  const normalizedSql = sql.toLowerCase();
  const matches = new Set<string>();

  schema.collections
    .filter((collection) => collection.category === 'table')
    .forEach((collection) => {
      const tableMetric = metricMappings[collection.name];
      (collection.columns || []).forEach((column) => {
        const metric = tableMetric?.fields?.[column.name];
        const candidates = [
          column.name,
          column.comment,
          metric?.metricName,
          metric?.description,
          ...(metric?.aliases || []),
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

        const sensitive = candidates.some((value) => SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(value)));
        if (!sensitive) return;

        if (normalizedSql.includes(column.name.toLowerCase())) {
          matches.add(column.name);
        }
      });
    });

  return Array.from(matches);
}

export function assertReadOnlyGuardrails(
  sql: string,
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap
) {
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

  const sensitiveColumns = extractSensitiveColumns(normalized, schema, metricMappings);
  if (sensitiveColumns.length > 0) {
    throw new Error(`当前回合已被安全网关阻断，命中了敏感字段：${sensitiveColumns.join('、')}。`);
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
    if (!tableColumns.has(column)) {
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
  const engine = workspace.databaseInstance.type as 'mysql' | 'pgsql';
  const normalizedSql = normalizeSqlForExecution(engine, plan.compiled.text);
  const wrappedSql = `SELECT * FROM (${normalizedSql.replace(/;+\s*$/, '')}) AS __db_harness_preview LIMIT ${previewLimit}`;
  const previewSql = plan.compiled.previewSql || normalizedSql;
  let result;

  try {
    result = await executeParameterizedDatabaseQuery(
      workspace.databaseInstance,
      wrappedSql,
      plan.compiled.values
    );
  } catch {
    const rawResult = await executeParameterizedDatabaseQuery(
      workspace.databaseInstance,
      normalizedSql,
      plan.compiled.values
    );
    result = {
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

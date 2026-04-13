import { DBHarnessAgentLogger } from '../memory/agent-logger';
import { DBHarnessGuardrailResult, DBHarnessQueryResult, DBHarnessWorkspaceContext } from '../core/types';
import { assertPlanResolvable, assertReadOnlyGuardrails, executeReadOnlyPlan } from '../tools/guardrail-tools';

export async function runGuardrailAgent(
  workspace: DBHarnessWorkspaceContext,
  queryResult: DBHarnessQueryResult,
  logger: DBHarnessAgentLogger
): Promise<DBHarnessGuardrailResult> {
  logger.log('Guardrail Agent', 'Input', {
    sql: queryResult.plan.compiled.text,
    datasource: workspace.databaseInstance.name,
    plan: queryResult.plan,
  });

  assertPlanResolvable(queryResult.plan, workspace.schema);
  assertReadOnlyGuardrails(queryResult.plan.compiled.text, workspace.schema, workspace.metricMappings);
  const execution = await executeReadOnlyPlan(queryResult.plan, workspace);
  const detail = `已通过只读执行网关校验，并返回 ${execution.rows.length} 行预览结果。`;

  logger.log('Guardrail Agent', 'Output', {
    detail,
    rowCount: execution.rows.length,
    columns: execution.columns,
    summary: execution.summary,
  });

  return {
    execution,
    detail,
  };
}

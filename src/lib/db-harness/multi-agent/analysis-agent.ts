import { DBHarnessAgentLogger } from '../memory/agent-logger';
import {
  DBHarnessAnalysisResult,
  DBHarnessGuardrailResult,
  DBHarnessQueryResult,
  DBHarnessSessionContext,
} from '../core/types';
import { buildAnalysisResult } from '../tools/analysis-tools';

export async function runAnalysisAgent(
  session: DBHarnessSessionContext,
  queryResult: DBHarnessQueryResult,
  guardrailResult: DBHarnessGuardrailResult,
  logger: DBHarnessAgentLogger
): Promise<DBHarnessAnalysisResult> {
  logger.log('Analysis Agent', 'Input', {
    question: session.latestUserMessage,
    sql: queryResult.aiPayload.sql,
    rowCount: guardrailResult.execution.rows.length,
    columns: guardrailResult.execution.columns,
  });

  const analysis = buildAnalysisResult(
    session.latestUserMessage,
    queryResult.aiPayload.message,
    guardrailResult.execution
  );

  logger.log('Analysis Agent', 'Output', analysis);
  return analysis;
}

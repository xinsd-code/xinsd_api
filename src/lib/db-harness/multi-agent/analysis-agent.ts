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
  const execution = guardrailResult.execution;
  if (!execution) {
    throw new Error('分析阶段缺少可用执行结果。');
  }

  logger.log('Analysis Agent', 'Input', {
    question: session.latestUserMessage,
    sql: queryResult.aiPayload.sql,
    rowCount: execution.rows.length,
    columns: execution.columns,
  });

  const analysis = buildAnalysisResult(
    session.latestUserMessage,
    queryResult.aiPayload.message,
    execution
  );

  logger.log('Analysis Agent', 'Output', analysis);
  return analysis;
}

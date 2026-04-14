import { DBHarnessChatTurnRequest, DBHarnessIntentResult, DBHarnessTurnResponse } from '../core/types';
import { buildFailureResponse, cloneTrace, createPendingTrace, updateTrace } from '../core/trace';
import { DBHarnessAgentLogger } from '../memory/agent-logger';
import { createDBHarnessSession } from '../session/session-context';
import { resolveDBHarnessWorkspace } from '../workspace/runtime';
import { DBHarnessGateway } from '../gateway/model-gateway';
import { buildKeywordSet, compactJson } from '../core/utils';
import { runIntentAgent } from './intent-agent';
import { runSchemaAgent } from './schema-agent';
import { runQueryAgent } from './query-agent';
import { runGuardrailAgent } from './guardrail-agent';
import { runAnalysisAgent } from './analysis-agent';
import { buildCatalogOverview, buildSemanticOverview } from '../tools/catalog-tools';

export class DBMultiAgent {
  async runChatTurn(input: DBHarnessChatTurnRequest): Promise<DBHarnessTurnResponse> {
    const session = createDBHarnessSession(input);
    const logger = new DBHarnessAgentLogger(session.turnId);
    const trace = createPendingTrace();
    const autoRetryEnabled = /^(1|true|yes|on)$/i.test(process.env.DB_HARNESS_EMPTY_RESULT_RETRY || '');

    logger.log('DB-Multi-Agent', 'Run started', {
      question: session.latestUserMessage,
      selectedDatabaseId: input.databaseInstanceId,
      selectedModel: input.selectedModel,
      currentSql: session.currentSql,
      currentResultSummary: session.currentResult?.summary || '',
    });

    const workspace = await resolveDBHarnessWorkspace(input);
    const gateway = new DBHarnessGateway(workspace, logger);

    let intentResult: DBHarnessIntentResult;
    try {
      intentResult = await runIntentAgent(session, workspace, gateway, logger);
      updateTrace(trace, 'intent', 'completed', intentResult.detail, {
        title: '传给 Schema Agent',
        payload: compactJson({
          intent: intentResult.intent,
          planningHints: intentResult.planningHints,
          question: session.latestUserMessage,
          datasource: workspace.databaseInstance.name,
          recentQuestions: session.recentQuestions,
        }, 1200),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Intent Agent 执行失败。';
      logger.log('Intent Agent', 'Error', detail);
      return buildFailureResponse(trace, 'intent', detail);
    }

    let schemaResult;
    try {
      schemaResult = await runSchemaAgent(session, workspace, gateway, logger);
      updateTrace(trace, 'schema', 'completed', schemaResult.detail, {
        title: '传给 Query Agent',
        payload: compactJson({
          normalizedTerms: schemaResult.nerPayload.normalizedTerms,
          matchedMetrics: schemaResult.nerPayload.matchedMetrics,
          timeHints: schemaResult.nerPayload.timeHints,
          usedFallback: schemaResult.usedFallback,
        }, 1600),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Schema Agent 执行失败。';
      logger.log('Schema Agent', 'Error', detail);
      return buildFailureResponse(trace, 'schema', detail);
    }

    let queryResult;
    try {
      queryResult = await runQueryAgent(session, workspace, intentResult, schemaResult, gateway, logger);
      updateTrace(trace, 'query', 'completed', queryResult.detail, {
        title: '传给 Guardrail Agent',
        payload: compactJson({
          message: queryResult.aiPayload.message,
          sql: queryResult.aiPayload.sql,
          plan: queryResult.plan,
          usedFallback: queryResult.usedFallback,
        }, 1800),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Query Agent 执行失败。';
      logger.log('Query Agent', 'Error', detail);
      return buildFailureResponse(trace, 'query', detail);
    }

    let guardrailResult;
    try {
      guardrailResult = await runGuardrailAgent(workspace, queryResult, logger);
      updateTrace(trace, 'guardrail', 'completed', guardrailResult.detail, {
        title: '传给 Analysis Agent',
        payload: compactJson({
          rowCount: guardrailResult.execution.rows.length,
          columns: guardrailResult.execution.columns,
          summary: guardrailResult.execution.summary,
          previewRows: guardrailResult.execution.rows.slice(0, 3),
        }, 1800),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Guardrail Agent 执行失败。';
      logger.log('Guardrail Agent', 'Error', detail);
      return buildFailureResponse(trace, 'guardrail', detail, queryResult.aiPayload.sql);
    }

    if (
      autoRetryEnabled
      && guardrailResult.execution.rows.length === 0
      && intentResult.planningHints.timeRangeDays
      && intentResult.planningHints.timeRangeDays <= 30
    ) {
      const relaxedHints = {
        ...intentResult.planningHints,
        timeRangeDays: Math.min(intentResult.planningHints.timeRangeDays * 3, 3650),
        notes: [
          ...intentResult.planningHints.notes,
          '空结果后已自动放宽时间范围重试一次。',
        ].slice(0, 8),
      };
      try {
        const retryIntentResult = {
          ...intentResult,
          planningHints: relaxedHints,
        };
        const retryQueryResult = await runQueryAgent(session, workspace, retryIntentResult, schemaResult, gateway, logger);
        const retryGuardrailResult = await runGuardrailAgent(workspace, retryQueryResult, logger);
        if (retryGuardrailResult.execution.rows.length > 0) {
          queryResult = retryQueryResult;
          guardrailResult = retryGuardrailResult;
          updateTrace(trace, 'query', 'completed', `${retryQueryResult.detail} 已触发空结果自动重试。`, {
            title: '传给 Guardrail Agent',
            payload: compactJson({
              message: retryQueryResult.aiPayload.message,
              sql: retryQueryResult.aiPayload.sql,
              plan: retryQueryResult.plan,
              usedFallback: retryQueryResult.usedFallback,
            }, 1800),
          });
          updateTrace(trace, 'guardrail', 'completed', `${retryGuardrailResult.detail} 已用放宽条件结果替换原结果。`, {
            title: '传给 Analysis Agent',
            payload: compactJson({
              rowCount: retryGuardrailResult.execution.rows.length,
              columns: retryGuardrailResult.execution.columns,
              summary: retryGuardrailResult.execution.summary,
              previewRows: retryGuardrailResult.execution.rows.slice(0, 3),
            }, 1800),
          });
        }
      } catch (error) {
        logger.log('DB-Multi-Agent', 'Empty result retry skipped', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const analysisResult = await runAnalysisAgent(session, queryResult, guardrailResult, logger);
      const keywords = buildKeywordSet(
        session.latestUserMessage,
        queryResult.plan.summary,
        queryResult.aiPayload.sql
      );
      const catalogOverview = buildCatalogOverview(workspace.catalog, keywords);
      const semanticOverview = buildSemanticOverview(workspace.semantic, keywords);
      updateTrace(trace, 'analysis', 'completed', analysisResult.detail, {
        title: '最终输出',
        payload: compactJson({
          reply: analysisResult.reply,
          summary: analysisResult.summary,
          followUps: analysisResult.followUps,
        }, 1200),
      });

      const response: DBHarnessTurnResponse = {
        outcome: guardrailResult.execution.rows.length === 0 ? 'empty' : 'success',
        reply: analysisResult.reply,
        trace: cloneTrace(trace),
        artifacts: {
          sql: guardrailResult.execution.sql,
          summary: analysisResult.summary,
          columns: guardrailResult.execution.columns,
          previewRows: guardrailResult.execution.rows.slice(0, 12),
          previewSql: guardrailResult.execution.previewSql,
          planSummary: queryResult.plan.summary,
          queryPlan: queryResult.plan,
          catalogOverview,
          semanticOverview,
        },
        followUps: analysisResult.followUps,
      };

      logger.log('DB-Multi-Agent', 'Run completed', {
        outcome: response.outcome,
        reply: response.reply,
        trace: response.trace,
        artifacts: response.artifacts,
      });

      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Analysis Agent 执行失败。';
      logger.log('Analysis Agent', 'Error', detail);
      return buildFailureResponse(trace, 'analysis', detail, guardrailResult.execution.sql);
    }
  }
}

export async function runDBHarnessChatTurn(input: DBHarnessChatTurnRequest) {
  const agent = new DBMultiAgent();
  return agent.runChatTurn(input);
}

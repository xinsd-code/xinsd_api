import {
  DBHarnessAgentTelemetry,
  DBHarnessChatTurnRequest,
  DBHarnessExecutionPayload,
  DBHarnessGuardrailResult,
  DBHarnessIntentResult,
  DBHarnessQueryResult,
  DBHarnessProgressEvent,
  DBHarnessSchemaResult,
  DBHarnessTurnResponse,
  DBHarnessWorkspaceContext,
  DBMultiAgentRole,
} from '../core/types';
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
import {
  buildFallbackNerPayload,
  buildFallbackPlanningHints,
  buildIntentDetail,
  buildNerCandidateBundle,
  buildSchemaDetail,
} from '../tools/planning-tools';
import { deriveKnowledgeEntries, mergeKnowledgeEntries } from '../memory/knowledge-memory';
import { cacheQueryExecution, getCachedQueryExecution } from '../cache/query-result-cache';
import { enqueueDBHarnessQueryMetrics } from '../metrics/query-metrics-collector';
import { rankSemanticEmbeddingMatches } from '../memory/embedding-index';
import { validateExecutionResult } from '../tools/validation-tools';

export interface DBMultiAgentRunOptions {
  onProgress?: (event: DBHarnessProgressEvent) => void;
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(0.98, Math.max(0.05, value)) : 0.05;
}

function buildProgressEvent(input: {
  turnId: string;
  stage: DBHarnessProgressEvent['stage'];
  status: DBHarnessProgressEvent['status'];
  message: string;
  detail?: string;
  trace?: DBHarnessProgressEvent['trace'];
}): DBHarnessProgressEvent {
  return {
    id: `${input.turnId}:${input.stage}:${input.status}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    turnId: input.turnId,
    stage: input.stage,
    status: input.status,
    message: input.message,
    detail: input.detail,
    trace: input.trace,
    timestamp: new Date().toISOString(),
  };
}

function buildFallbackIntentResult(sessionQuestion: string, workspace: DBHarnessWorkspaceContext): DBHarnessIntentResult {
  const planningHints = buildFallbackPlanningHints(sessionQuestion, workspace);
  return {
    intent: planningHints.intent,
    planningHints,
    detail: buildIntentDetail(planningHints, workspace.databaseInstance.name),
  };
}

async function buildFallbackSchemaResult(
  sessionQuestion: string,
  workspace: DBHarnessWorkspaceContext
): Promise<DBHarnessSchemaResult> {
  const keywords = buildKeywordSet(sessionQuestion, workspace.runtimeConfig?.promptStrategy);
  const semanticMatches = await rankSemanticEmbeddingMatches(
    sessionQuestion,
    workspace.semanticEmbeddingIndex
  );
  const candidateBundle = buildNerCandidateBundle(
    workspace.schema,
    workspace.metricMappings,
    keywords,
    workspace.runtimeConfig?.nerCandidateLimit,
    semanticMatches
  );
  const nerPayload = buildFallbackNerPayload(
    sessionQuestion,
    workspace.schema,
    workspace.metricMappings,
    workspace.runtimeConfig?.nerCandidateLimit,
    semanticMatches
  );
  const knowledgeEntries = mergeKnowledgeEntries(
    workspace.knowledge,
    deriveKnowledgeEntries(workspace.schema, workspace.metricMappings, nerPayload)
  );
  return {
    nerPayload,
    candidateBundle,
    knowledgeEntries,
    detail: buildSchemaDetail(nerPayload, candidateBundle),
    usedFallback: true,
  };
}

function calculateTurnConfidence(input: {
  intentResult: DBHarnessIntentResult;
  schemaResult: DBHarnessSchemaResult;
  queryResult: DBHarnessQueryResult;
  execution: DBHarnessExecutionPayload;
  fromCache: boolean;
  validationScore?: number;
}): number {
  let score = 0.42;
  const planningHints = input.intentResult.planningHints;
  const nerPayload = input.schemaResult.nerPayload;

  if (planningHints.candidateTables.length > 0) score += 0.06;
  if (planningHints.metrics.length > 0) score += 0.04;
  if (planningHints.dimensions.length > 0) score += 0.03;
  if (planningHints.timeRangeDays) score += 0.02;
  if (nerPayload.matchedMetrics.length > 0) {
    score += Math.min(0.12, nerPayload.matchedMetrics.length * 0.02);
    const highConfidenceCount = nerPayload.matchedMetrics.filter((item) => item.confidence === 'high').length;
    score += Math.min(0.08, highConfidenceCount * 0.03);
  }
  if (nerPayload.unmatchedTerms.length > 0) {
    score -= Math.min(0.12, nerPayload.unmatchedTerms.length * 0.02);
  }
  if (input.schemaResult.usedFallback) score -= 0.06;
  if (input.queryResult.usedFallback) score -= 0.1;
  if (input.execution.rows.length > 0) {
    score += Math.min(0.12, input.execution.rows.length >= 12 ? 0.12 : 0.08);
  } else {
    score -= 0.12;
  }
  if (input.fromCache) score += 0.04;
  if (typeof input.validationScore === 'number') {
    score += (input.validationScore - 0.5) * 0.28;
  }

  return clampConfidence(score);
}

function buildAgentTelemetry(
  intentResult: DBHarnessIntentResult,
  schemaResult: DBHarnessSchemaResult,
  queryResult: DBHarnessQueryResult
): Partial<Record<DBMultiAgentRole, DBHarnessAgentTelemetry>> {
  return {
    intent: intentResult.telemetry,
    schema: schemaResult.telemetry,
    query: queryResult.telemetry,
  };
}

export class DBMultiAgent {
  async runChatTurn(input: DBHarnessChatTurnRequest, options: DBMultiAgentRunOptions = {}): Promise<DBHarnessTurnResponse> {
    const session = createDBHarnessSession(input);
    const logger = new DBHarnessAgentLogger(session.turnId);
    const trace = createPendingTrace();
    const autoRetryEnabled = /^(1|true|yes|on)$/i.test(process.env.DB_HARNESS_EMPTY_RESULT_RETRY || '');
    const agentTelemetry: Partial<Record<DBMultiAgentRole, DBHarnessAgentTelemetry>> = {};
    const progressEvents: DBHarnessProgressEvent[] = [];
    const emitProgress = (
      stage: DBHarnessProgressEvent['stage'],
      status: DBHarnessProgressEvent['status'],
      message: string,
      detail?: string,
      progressTrace?: DBHarnessProgressEvent['trace']
    ) => {
      const event = buildProgressEvent({
        turnId: session.turnId,
        stage,
        status,
        message,
        detail,
        trace: progressTrace,
      });
      progressEvents.push(event);
      options.onProgress?.(event);
      return event;
    };
    const emitTraceProgress = (
      stage: DBHarnessProgressEvent['stage'],
      status: DBHarnessProgressEvent['status'],
      message: string,
      detail?: string
    ) => emitProgress(stage, status, message, detail, cloneTrace(trace));

    logger.log('DB-Multi-Agent', 'Run started', {
      question: session.latestUserMessage,
      selectedDatabaseId: input.databaseInstanceId,
      selectedModel: input.selectedModel,
      currentSql: session.currentSql,
      currentResultSummary: session.currentResult?.summary || '',
    });

    emitProgress('session', 'start', '已接收请求，正在准备会话。');
    const workspace = await resolveDBHarnessWorkspace(input);
    emitProgress('workspace', 'complete', 'Workspace 已解析完成，正在进入多 Agent 调度。', [
      `数据库：${workspace.databaseInstance.name}`,
      `引擎：${workspace.databaseInstance.type}`,
    ].join('；'));
    const gateway = new DBHarnessGateway(workspace, logger);

    updateTrace(trace, 'intent', 'running', '正在分析用户意图。');
    updateTrace(trace, 'schema', 'running', '正在识别字段语义。');
    emitTraceProgress('intent', 'running', 'Intent Agent 已启动，正在分析问题意图。');
    emitTraceProgress('schema', 'running', 'Schema Agent 已启动，正在识别字段语义。');

    let intentResult: DBHarnessIntentResult;
    let schemaResult: DBHarnessSchemaResult;

    const [intentSettled, schemaSettled] = await Promise.allSettled([
      runIntentAgent(session, workspace, gateway, logger),
      runSchemaAgent(session, workspace, gateway, logger),
    ]);

    if (intentSettled.status === 'fulfilled') {
      intentResult = intentSettled.value;
      agentTelemetry.intent = intentResult.telemetry;
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
      emitTraceProgress('intent', 'complete', 'Intent Agent 已完成。', intentResult.detail);
    } else {
      const fallback = buildFallbackIntentResult(session.latestUserMessage, workspace);
      intentResult = fallback;
      updateTrace(trace, 'intent', 'completed', `${fallback.detail} 已回退到规则引擎。`, {
        title: '传给 Schema Agent',
        payload: compactJson({
          intent: fallback.intent,
          planningHints: fallback.planningHints,
          question: session.latestUserMessage,
          datasource: workspace.databaseInstance.name,
          recentQuestions: session.recentQuestions,
        }, 1200),
      });
      emitTraceProgress('intent', 'complete', 'Intent Agent 回退到规则引擎完成。', fallback.detail);
      logger.log('Intent Agent', 'Fallback Output', {
        reason: intentSettled.reason instanceof Error ? intentSettled.reason.message : String(intentSettled.reason),
        planningHints: fallback.planningHints,
        detail: fallback.detail,
      });
    }

    if (schemaSettled.status === 'fulfilled') {
      schemaResult = schemaSettled.value;
      agentTelemetry.schema = schemaResult.telemetry;
      updateTrace(trace, 'schema', 'completed', schemaResult.detail, {
        title: '传给 Query Agent',
        payload: compactJson({
          normalizedTerms: schemaResult.nerPayload.normalizedTerms,
          matchedMetrics: schemaResult.nerPayload.matchedMetrics,
          timeHints: schemaResult.nerPayload.timeHints,
          usedFallback: schemaResult.usedFallback,
        }, 1600),
      });
      emitTraceProgress('schema', 'complete', 'Schema Agent 已完成。', schemaResult.detail);
    } else {
      const fallback = await buildFallbackSchemaResult(session.latestUserMessage, workspace);
      schemaResult = fallback;
      updateTrace(trace, 'schema', 'completed', `${fallback.detail} 已回退到规则引擎。`, {
        title: '传给 Query Agent',
        payload: compactJson({
          normalizedTerms: fallback.nerPayload.normalizedTerms,
          matchedMetrics: fallback.nerPayload.matchedMetrics,
          timeHints: fallback.nerPayload.timeHints,
          usedFallback: fallback.usedFallback,
        }, 1600),
      });
      emitTraceProgress('schema', 'complete', 'Schema Agent 回退到规则引擎完成。', fallback.detail);
      logger.log('Schema Agent', 'Fallback Output', {
        reason: schemaSettled.reason instanceof Error ? schemaSettled.reason.message : String(schemaSettled.reason),
        detail: fallback.detail,
        nerPayload: fallback.nerPayload,
      });
    }

    let queryResult: DBHarnessQueryResult;
    try {
      updateTrace(trace, 'query', 'running', '正在生成查询计划。');
      emitTraceProgress('query', 'running', 'Query Agent 正在生成查询计划。');
      queryResult = await runQueryAgent(session, workspace, intentResult, schemaResult, gateway, logger);
      agentTelemetry.query = queryResult.telemetry;
      updateTrace(trace, 'query', 'completed', queryResult.detail, {
        title: '传给 Guardrail Agent',
        payload: compactJson({
          message: queryResult.aiPayload.message,
          sql: queryResult.aiPayload.sql,
          plan: queryResult.plan,
          usedFallback: queryResult.usedFallback,
        }, 1800),
      });
      emitTraceProgress('query', 'complete', 'Query Agent 已完成。', queryResult.detail);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Query Agent 执行失败。';
      logger.log('Query Agent', 'Error', detail);
      const response = buildFailureResponse(trace, 'query', detail);
      response.progress = progressEvents;
      enqueueDBHarnessQueryMetrics({
        session,
        workspace,
        trace,
        response,
        sql: session.currentSql || session.latestUserMessage,
        agentTelemetry,
        errorMessage: detail,
      });
      return response;
    }

    let guardrailExecution: DBHarnessExecutionPayload | undefined;
    let guardrailResult: DBHarnessGuardrailResult;
    let fromCache = false;
    const cachedExecution = getCachedQueryExecution({
      databaseId: workspace.databaseInstance.id,
      engine: workspace.databaseInstance.type,
      sql: queryResult.plan.compiled.text,
    });

    try {
      if (cachedExecution) {
        fromCache = true;
        guardrailExecution = cachedExecution.execution;
        guardrailResult = {
          execution: guardrailExecution,
          detail: `已命中查询结果缓存，直接复用 ${guardrailExecution.rows.length} 行预览结果。`,
        };
        updateTrace(trace, 'guardrail', 'completed', guardrailResult.detail, {
          title: '传给 Analysis Agent',
          payload: compactJson({
            rowCount: guardrailExecution.rows.length,
            columns: guardrailExecution.columns,
            summary: guardrailExecution.summary,
            previewRows: guardrailExecution.rows.slice(0, 3),
          }, 1800),
        });
        emitTraceProgress('cache', 'info', '查询结果命中缓存，直接复用预览结果。', guardrailResult.detail);
      } else {
        updateTrace(trace, 'guardrail', 'running', '正在执行只读校验与查询预览。');
        emitTraceProgress('guardrail', 'running', 'Guardrail Agent 正在执行只读校验与查询预览。');
        guardrailResult = await runGuardrailAgent(workspace, queryResult, logger);
        guardrailExecution = guardrailResult.execution;
        if (!guardrailExecution) {
          throw new Error('Guardrail Agent 执行失败。');
        }
        updateTrace(trace, 'guardrail', 'completed', guardrailResult.detail, {
          title: '传给 Analysis Agent',
          payload: compactJson({
            rowCount: guardrailExecution.rows.length,
            columns: guardrailExecution.columns,
            summary: guardrailExecution.summary,
            previewRows: guardrailExecution.rows.slice(0, 3),
          }, 1800),
        });
        emitTraceProgress('guardrail', 'complete', 'Guardrail Agent 已完成。', guardrailResult.detail);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Guardrail Agent 执行失败。';
      logger.log('Guardrail Agent', 'Error', detail);
      const response = buildFailureResponse(trace, 'guardrail', detail, queryResult.aiPayload.sql);
      response.progress = progressEvents;
      enqueueDBHarnessQueryMetrics({
        session,
        workspace,
        trace,
        response,
        sql: queryResult.plan.compiled.text,
        agentTelemetry,
        errorMessage: detail,
      });
      return response;
    }

    const initialExecution = guardrailExecution;
    if (!initialExecution) {
      throw new Error('Guardrail Agent 执行失败。');
    }

    if (
      autoRetryEnabled
      && initialExecution.rows.length === 0
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
        const retryGuardrailExecution = retryGuardrailResult.execution;
        if (retryGuardrailExecution && retryGuardrailExecution.rows.length > 0) {
          queryResult = retryQueryResult;
          agentTelemetry.query = retryQueryResult.telemetry;
          guardrailResult = retryGuardrailResult;
          guardrailExecution = retryGuardrailExecution;
          fromCache = false;
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
              rowCount: retryGuardrailExecution.rows.length,
              columns: retryGuardrailExecution.columns,
              summary: retryGuardrailExecution.summary,
              previewRows: retryGuardrailExecution.rows.slice(0, 3),
            }, 1800),
          });
          emitTraceProgress('retry', 'update', '空结果自动重试成功，已切换到更宽松的条件。', retryQueryResult.detail);
        }
      } catch (error) {
        logger.log('DB-Multi-Agent', 'Empty result retry skipped', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const finalExecution = guardrailExecution || initialExecution;
    if (!fromCache && finalExecution) {
      cacheQueryExecution({
        databaseId: workspace.databaseInstance.id,
        engine: workspace.databaseInstance.type,
        sql: queryResult.plan.compiled.text,
        execution: finalExecution,
      });
    }

    try {
      updateTrace(trace, 'analysis', 'running', '正在组织最终回答。');
      emitTraceProgress('analysis', 'running', 'Analysis Agent 正在组织最终回答。');
      const analysisResult = await runAnalysisAgent(session, queryResult, guardrailResult, logger);
      const keywords = buildKeywordSet(
        session.latestUserMessage,
        queryResult.plan.summary,
        queryResult.aiPayload.sql
      );
      const catalogOverview = buildCatalogOverview(workspace.catalog, keywords);
      const semanticOverview = buildSemanticOverview(workspace.semantic, keywords);
      const validation = validateExecutionResult(
        session.latestUserMessage,
        queryResult.plan,
        finalExecution
      );
      const confidence = calculateTurnConfidence({
        intentResult,
        schemaResult,
        queryResult,
        execution: finalExecution,
        fromCache,
        validationScore: validation.score,
      });
      updateTrace(trace, 'analysis', 'completed', analysisResult.detail, {
        title: '最终输出',
        payload: compactJson({
          reply: analysisResult.reply,
          summary: analysisResult.summary,
          followUps: analysisResult.followUps,
        }, 1200),
      });
      emitTraceProgress('analysis', 'complete', 'Analysis Agent 已完成。', analysisResult.detail);

      const response: DBHarnessTurnResponse = {
        outcome: finalExecution.rows.length === 0 ? 'empty' : 'success',
        reply: analysisResult.reply,
        trace: cloneTrace(trace),
        confidence,
        fromCache,
        progress: progressEvents,
        artifacts: {
          sql: finalExecution.sql,
          summary: analysisResult.summary,
          columns: finalExecution.columns,
          previewRows: finalExecution.rows.slice(0, 12),
          previewSql: finalExecution.previewSql,
          planSummary: queryResult.plan.summary,
          queryPlan: queryResult.plan,
          catalogOverview,
          semanticOverview,
          validation,
          appliedUpgrades: workspace.activeUpgrades || [],
          semanticOverlays: workspace.semanticOverlays || [],
        },
        followUps: analysisResult.followUps,
      };

      enqueueDBHarnessQueryMetrics({
        session,
        workspace,
        trace,
        response,
        sql: finalExecution.sql,
        agentTelemetry: buildAgentTelemetry(intentResult, schemaResult, queryResult),
      });

      logger.log('DB-Multi-Agent', 'Run completed', {
        outcome: response.outcome,
        reply: response.reply,
        confidence: response.confidence,
        fromCache: response.fromCache,
        trace: response.trace,
        artifacts: response.artifacts,
      });
      emitProgress('final', 'complete', response.outcome === 'empty' ? '本轮执行完成，但未返回数据行。' : '本轮执行完成并返回结果。', response.reply);

      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Analysis Agent 执行失败。';
      logger.log('Analysis Agent', 'Error', detail);
      const response = buildFailureResponse(trace, 'analysis', detail, finalExecution.sql);
      response.progress = progressEvents;
      enqueueDBHarnessQueryMetrics({
        session,
        workspace,
        trace,
        response,
        sql: finalExecution.sql,
        agentTelemetry: buildAgentTelemetry(intentResult, schemaResult, queryResult),
        errorMessage: detail,
      });
      return response;
    }
  }
}

export async function runDBHarnessChatTurn(input: DBHarnessChatTurnRequest, options: DBMultiAgentRunOptions = {}) {
  const agent = new DBMultiAgent();
  return agent.runChatTurn(input, options);
}

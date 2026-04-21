import { createHash } from 'node:crypto';
import { upsertDBHarnessQueryMetric } from '@/lib/db';
import {
  DBHarnessAgentTelemetry,
  DBHarnessQueryMetricRecord,
  DBHarnessSessionContext,
  DBHarnessTurnResponse,
  DBHarnessWorkspaceContext,
  DBMultiAgentRole,
  DBMultiAgentTraceStep,
} from '../core/types';
import { buildQueryResultFingerprint } from '../cache/query-result-cache';
import { maybeTriggerOnlineGepaEvaluation } from '../gepa/gepa-service';

export interface CollectDBHarnessQueryMetricsInput {
  session: DBHarnessSessionContext;
  workspace: DBHarnessWorkspaceContext;
  trace: DBMultiAgentTraceStep[];
  response: DBHarnessTurnResponse;
  sql: string;
  agentTelemetry: Partial<Record<DBMultiAgentRole, DBHarnessAgentTelemetry>>;
  queryFingerprint?: string;
  errorMessage?: string;
}

function buildQuestionHash(question: string): string {
  return createHash('sha256').update(question.trim()).digest('hex');
}

function buildRowCount(response: DBHarnessTurnResponse): number {
  return Array.isArray(response.artifacts?.previewRows) ? response.artifacts?.previewRows.length : 0;
}

export function buildDBHarnessQueryMetricRecord(input: CollectDBHarnessQueryMetricsInput): DBHarnessQueryMetricRecord {
  const startedAt = input.trace.find((step) => step.startedAt)?.startedAt || input.session.startedAt;
  const completedAt = new Date().toISOString();
  const rowCount = buildRowCount(input.response);
  const queryFingerprint = input.queryFingerprint || buildQueryResultFingerprint({
    databaseId: input.workspace.databaseInstance.id,
    engine: input.workspace.databaseInstance.type,
    sql: input.sql,
  });

  return {
    id: '',
    turnId: input.session.turnId,
    workspaceId: input.workspace.workspaceId || '',
    databaseId: input.workspace.databaseInstance.id,
    engine: input.workspace.databaseInstance.type,
    question: input.session.latestUserMessage.trim(),
    questionHash: buildQuestionHash(input.session.latestUserMessage),
    sql: input.sql,
    queryFingerprint,
    outcome: input.response.outcome,
    confidence: input.response.confidence,
    fromCache: input.response.fromCache === true,
    rowCount,
    agentTelemetry: input.agentTelemetry,
    appliedUpgradeIds: (input.workspace.activeUpgrades || []).map((item) => item.upgradeId).slice(0, 24),
    semanticOverlayIds: (input.workspace.semanticOverlays || []).map((item) => item.upgradeId).slice(0, 24),
    validationScore: input.response.artifacts?.validation?.score,
    feedbackLabel: 'none',
    retryUsed: input.trace.some((step) => step.detail.includes('空结果重试') || step.detail.includes('retry')),
    labels: [
      input.response.outcome,
      input.response.fromCache ? 'from-cache' : 'live',
      input.response.outcome === 'empty' ? 'empty-result' : '',
      input.response.artifacts?.validation?.status ? `validation-${input.response.artifacts.validation.status}` : '',
    ].filter(Boolean),
    errorMessage: input.errorMessage || (input.response.outcome === 'error' ? input.response.reply : undefined),
    createdAt: startedAt,
    updatedAt: completedAt,
  };
}

export function enqueueDBHarnessQueryMetrics(input: CollectDBHarnessQueryMetricsInput): void {
  queueMicrotask(() => {
    try {
      const record = buildDBHarnessQueryMetricRecord(input);
      upsertDBHarnessQueryMetric(record);
      void maybeTriggerOnlineGepaEvaluation({
        workspaceId: record.workspaceId,
        databaseId: record.databaseId,
        turnId: record.turnId,
      }).catch((error) => {
        console.error('Failed to trigger online GEPA evaluation:', error);
      });
    } catch (error) {
      console.error('Failed to persist DB Harness query metrics:', error);
    }
  });
}

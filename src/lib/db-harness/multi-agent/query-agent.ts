import { extractJsonPayload, isLikelyModelUnavailable } from '../core/utils';
import { DBHarnessAgentLogger } from '../memory/agent-logger';
import { DBHarnessGateway } from '../gateway/model-gateway';
import { buildCondensedSessionMessages } from '../session/session-context';
import {
  DBHarnessIntentResult,
  DBHarnessQueryResult,
  DBHarnessSchemaResult,
  DBHarnessSessionContext,
  DBHarnessWorkspaceContext,
} from '../core/types';
import {
  buildPlaceholderQueryPlan,
  buildFallbackQueryPlan,
  buildQueryPromptContext,
  parseQueryAgentPayload,
} from '../tools/planning-tools';

export async function runQueryAgent(
  session: DBHarnessSessionContext,
  workspace: DBHarnessWorkspaceContext,
  intentResult: DBHarnessIntentResult,
  schemaResult: DBHarnessSchemaResult,
  gateway: DBHarnessGateway,
  logger: DBHarnessAgentLogger
): Promise<DBHarnessQueryResult> {
  const engine = workspace.databaseInstance.type as 'mysql' | 'pgsql' | 'mongo';

  logger.log('Query Agent', 'Input', {
    question: session.latestUserMessage,
    matchedMetrics: schemaResult.nerPayload.matchedMetrics,
    currentSql: session.currentSql,
    currentResultSummary: session.currentResult?.summary || '',
  });

  let fallbackResult: DBHarnessQueryResult | null = null;
  let fallbackErrorMessage = '';
  try {
    fallbackResult = buildFallbackQueryPlan(
      session.latestUserMessage,
      engine,
      workspace,
      schemaResult.nerPayload,
      intentResult.planningHints
    );
  } catch (error) {
    fallbackErrorMessage = error instanceof Error ? error.message : String(error);
    logger.log('Query Agent', 'Fallback Seed Unavailable', fallbackErrorMessage);
  }

  try {
    const condensedMessages = buildCondensedSessionMessages(session, {
      keepRecentMessages: 4,
      maxSummaryLength: 800,
    });
    const fallbackPlan = fallbackResult?.plan || buildPlaceholderQueryPlan(
      session.latestUserMessage,
      engine,
      intentResult.planningHints.intent
    );
    const { content, telemetry } = await gateway.runQueryPrompt(
      (level) => buildQueryPromptContext(
        session,
        workspace,
        intentResult.planningHints,
        schemaResult.nerPayload,
        level
      ),
      condensedMessages
    );
    const parsed = parseQueryAgentPayload(
      extractJsonPayload(content),
      engine,
      fallbackPlan
    );
    const detail = `已基于 ${workspace.selectedModel.modelId} 生成只读查询，并围绕当前语义映射补齐排序、聚合和结果限制。`;

    logger.log('Query Agent', 'Output', {
      detail,
      aiPayload: parsed.aiPayload,
      plan: parsed.plan,
      condensedMessageCount: condensedMessages.length,
    });

    return {
      aiPayload: parsed.aiPayload,
      plan: parsed.plan,
      detail,
      usedFallback: false,
      telemetry,
    };
  } catch (error) {
    if (!isLikelyModelUnavailable(error)) {
      logger.log('Query Agent', 'Error', error instanceof Error ? error.message : String(error));
      throw error;
    }

    if (!fallbackResult) {
      throw new Error(fallbackErrorMessage || '模型规划不可用，且规则引擎没有找到可映射字段。');
    }

    const detail = '模型规划不可用，已回退到规则引擎生成只读查询。';

    logger.log('Query Agent', 'Fallback Output', {
      reason: error instanceof Error ? error.message : String(error),
      detail,
      aiPayload: fallbackResult.aiPayload,
      plan: fallbackResult.plan,
    });

    return {
      aiPayload: fallbackResult.aiPayload,
      plan: fallbackResult.plan,
      detail,
      usedFallback: true,
      telemetry: undefined,
    };
  }
}

import { extractJsonPayload, isLikelyModelUnavailable, parseJsonSafely } from '../core/utils';
import { DBHarnessIntentResult, DBHarnessSessionContext, DBHarnessWorkspaceContext } from '../core/types';
import { DBHarnessGateway } from '../gateway/model-gateway';
import { DBHarnessAgentLogger } from '../memory/agent-logger';
import {
  buildFallbackPlanningHints,
  buildIntentDetail,
  buildIntentPromptContext,
  sanitizePlanningHints,
} from '../tools/planning-tools';

export async function runIntentAgent(
  session: DBHarnessSessionContext,
  workspace: DBHarnessWorkspaceContext,
  gateway: DBHarnessGateway,
  logger: DBHarnessAgentLogger
): Promise<DBHarnessIntentResult> {
  logger.log('Intent Agent', 'Input', {
    question: session.latestUserMessage,
    datasource: workspace.databaseInstance.name,
    model: workspace.selectedModel.modelId,
    recentQuestions: session.recentQuestions,
  });

  try {
    const promptContext = buildIntentPromptContext(session, workspace);
    const { content, telemetry } = await gateway.runIntentPrompt(promptContext, [{ role: 'user', content: session.latestUserMessage }]);
    const planningHints = sanitizePlanningHints(parseJsonSafely(extractJsonPayload(content)));
    const detail = buildIntentDetail(planningHints, workspace.databaseInstance.name);

    logger.log('Intent Agent', 'Output', {
      intent: planningHints.intent,
      planningHints,
      detail,
    });

    return {
      intent: planningHints.intent,
      planningHints,
      detail,
      telemetry,
    };
  } catch (error) {
    if (!isLikelyModelUnavailable(error)) {
      logger.log('Intent Agent', 'Error', error instanceof Error ? error.message : String(error));
      throw error;
    }

    const planningHints = buildFallbackPlanningHints(session.latestUserMessage, workspace);
    const detail = buildIntentDetail(planningHints, workspace.databaseInstance.name);

    logger.log('Intent Agent', 'Fallback Output', {
      reason: error instanceof Error ? error.message : String(error),
      planningHints,
      detail,
    });

    return {
      intent: planningHints.intent,
      planningHints,
      detail,
      telemetry: undefined,
    };
  }
}

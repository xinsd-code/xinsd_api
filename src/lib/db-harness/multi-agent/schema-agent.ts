import { extractJsonPayload } from '../core/utils';
import { DBHarnessGateway } from '../gateway/model-gateway';
import { DBHarnessAgentLogger } from '../memory/agent-logger';
import { deriveKnowledgeEntries, mergeKnowledgeEntries } from '../memory/knowledge-memory';
import { buildKeywordSet, isLikelyModelUnavailable } from '../core/utils';
import {
  DBHarnessSchemaResult,
  DBHarnessSessionContext,
  DBHarnessWorkspaceContext,
} from '../core/types';
import {
  buildFallbackNerPayload,
  buildNerCandidateBundle,
  buildSchemaDetail,
  buildSchemaPromptContext,
  parseSchemaAgentPayload,
} from '../tools/planning-tools';

export async function runSchemaAgent(
  session: DBHarnessSessionContext,
  workspace: DBHarnessWorkspaceContext,
  gateway: DBHarnessGateway,
  logger: DBHarnessAgentLogger
): Promise<DBHarnessSchemaResult> {
  const keywords = buildKeywordSet(session.latestUserMessage, session.currentSql);
  const candidateBundle = buildNerCandidateBundle(workspace.schema, workspace.metricMappings, keywords);

  logger.log('Schema Agent', 'Input', {
    question: session.latestUserMessage,
    candidateCount: candidateBundle.candidateCount,
    totalAvailable: candidateBundle.totalAvailable,
    truncated: candidateBundle.truncated,
  });

  try {
    const promptContext = buildSchemaPromptContext(session, workspace, candidateBundle);
    const { content } = await gateway.runSchemaPrompt(promptContext, [{ role: 'user', content: session.latestUserMessage }]);
    const nerPayload = parseSchemaAgentPayload(extractJsonPayload(content));
    const knowledgeEntries = mergeKnowledgeEntries(
      workspace.knowledge,
      deriveKnowledgeEntries(workspace.schema, workspace.metricMappings, nerPayload)
    );
    const detail = buildSchemaDetail(nerPayload, candidateBundle);

    logger.log('Schema Agent', 'Output', {
      detail,
      nerPayload,
      knowledgeEntries,
    });

    return {
      nerPayload,
      candidateBundle,
      knowledgeEntries,
      detail,
      usedFallback: false,
    };
  } catch (error) {
    if (!isLikelyModelUnavailable(error)) {
      logger.log('Schema Agent', 'Error', error instanceof Error ? error.message : String(error));
      throw error;
    }

    const nerPayload = buildFallbackNerPayload(session.latestUserMessage, workspace.schema, workspace.metricMappings);
    const knowledgeEntries = mergeKnowledgeEntries(
      workspace.knowledge,
      deriveKnowledgeEntries(workspace.schema, workspace.metricMappings, nerPayload)
    );
    const detail = '模型规划不可用，已回退到规则引擎完成字段语义识别与候选实体选择。';

    logger.log('Schema Agent', 'Fallback Output', {
      reason: error instanceof Error ? error.message : String(error),
      detail,
      nerPayload,
      knowledgeEntries,
    });

    return {
      nerPayload,
      candidateBundle,
      knowledgeEntries,
      detail,
      usedFallback: true,
    };
  }
}

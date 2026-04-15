import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAIModelHeaders } from '@/lib/ai-models';
import { DBHarnessSessionContext, DBHarnessWorkspaceContext } from '../core/types';
import { DBHarnessAgentLogger } from '../memory/agent-logger';
import { getModelErrorMessage, isRecord, parseJsonSafely } from '../core/utils';

const promptTemplateCache = new Map<string, string>();
const QUERY_PROMPT_CHAR_THRESHOLD = 14000;

async function loadPromptTemplate(filename: string): Promise<string> {
  const cached = promptTemplateCache.get(filename);
  if (cached) return cached;
  const promptPath = path.join(process.cwd(), 'src/prompts', filename);
  const template = await readFile(promptPath, 'utf8');
  promptTemplateCache.set(filename, template);
  return template;
}

function renderPromptTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((result, [key, value]) => (
    result.replaceAll(`{{${key}}}`, value)
  ), template);
}

function buildUpstreamPayload(systemPrompt: string, messages: DBHarnessSessionContext['messages'], modelId: string) {
  return {
    model: modelId,
    temperature: 0.2,
    stream: false,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };
}

async function requestModelContent(
  endpoint: string,
  profile: DBHarnessWorkspaceContext['profile'],
  modelId: string,
  systemPrompt: string,
  messages: DBHarnessSessionContext['messages']
): Promise<string> {
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(endpoint, {
      method: 'POST',
      headers: buildAIModelHeaders(profile),
      body: JSON.stringify(buildUpstreamPayload(systemPrompt, messages, modelId)),
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.name === 'TimeoutError'
        || error.name === 'AbortError'
        || error.message.toLowerCase().includes('aborted due to timeout')
        || error.message.toLowerCase().includes('operation was aborted')
      )
    ) {
      throw new Error('模型请求超时，请稍后重试或切换到响应更快的模型。');
    }
    throw error;
  }

  const upstreamText = await upstreamResponse.text();
  const upstreamJson = parseJsonSafely(upstreamText);

  if (!upstreamResponse.ok) {
    throw new Error(getModelErrorMessage(upstreamJson));
  }

  return isRecord(upstreamJson)
    && Array.isArray(upstreamJson.choices)
    && upstreamJson.choices.length > 0
    && isRecord(upstreamJson.choices[0])
    && isRecord(upstreamJson.choices[0].message)
    && typeof upstreamJson.choices[0].message.content === 'string'
    ? upstreamJson.choices[0].message.content
    : '';
}

export class DBHarnessGateway {
  constructor(
    private readonly workspace: DBHarnessWorkspaceContext,
    private readonly logger: DBHarnessAgentLogger
  ) {}

  private getModelContext(useNer = false) {
    if (useNer && this.workspace.nerSelectedModel && this.workspace.nerProfile && this.workspace.nerEndpoint) {
      return {
        selectedModel: this.workspace.nerSelectedModel,
        profile: this.workspace.nerProfile,
        endpoint: this.workspace.nerEndpoint,
      };
    }

    return {
      selectedModel: this.workspace.selectedModel,
      profile: this.workspace.profile,
      endpoint: this.workspace.endpoint,
    };
  }

  async runIntentPrompt(context: string, messages: DBHarnessSessionContext['messages']) {
    const model = this.getModelContext(false);
    const prompt = renderPromptTemplate(
      await loadPromptTemplate('db-harness-intent-agent.md'),
      { DYNAMIC_CONTEXT: context }
    );
    this.logger.log('Gateway', 'Dispatching Intent Agent prompt', {
      model: model.selectedModel.modelId,
      datasource: this.workspace.databaseInstance.name,
      systemPromptChars: prompt.length,
      messageCount: messages.length,
      messageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    });
    const content = await requestModelContent(model.endpoint, model.profile, model.selectedModel.modelId, prompt, messages);
    return { prompt, content };
  }

  async runSchemaPrompt(context: string, messages: DBHarnessSessionContext['messages']) {
    const model = this.getModelContext(true);
    const prompt = renderPromptTemplate(
      await loadPromptTemplate('db-harness-schema-agent.md'),
      { DYNAMIC_CONTEXT: context }
    );
    this.logger.log('Gateway', 'Dispatching Schema Agent prompt', {
      model: model.selectedModel.modelId,
      datasource: this.workspace.databaseInstance.name,
      systemPromptChars: prompt.length,
      messageCount: messages.length,
      messageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    });
    const content = await requestModelContent(model.endpoint, model.profile, model.selectedModel.modelId, prompt, messages);
    return { prompt, content };
  }

  async runQueryPrompt(
    contextBuilder: (level: 'standard' | 'compact' | 'minimal') => string,
    messages: DBHarnessSessionContext['messages']
  ) {
    const model = this.getModelContext(false);
    const template = await loadPromptTemplate('db-harness-query-agent.md');
    const messageChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    let compressionLevel: 'standard' | 'compact' | 'minimal' = 'standard';
    const preferredLevel = this.workspace.runtimeConfig?.preferredCompressionLevel;
    const startLevels = (() => {
      if (preferredLevel === 'minimal') {
        return ['minimal'] as const;
      }
      if (preferredLevel === 'compact') {
        return ['compact', 'minimal'] as const;
      }
      return ['standard', 'compact', 'minimal'] as const;
    })();
    let prompt = '';

    for (const level of startLevels) {
      const context = contextBuilder(level);
      const candidate = renderPromptTemplate(template, { DYNAMIC_CONTEXT: context });
      prompt = candidate;
      compressionLevel = level;
      if (candidate.length + messageChars <= QUERY_PROMPT_CHAR_THRESHOLD) {
        break;
      }
    }

    this.logger.log('Gateway', 'Dispatching Query Agent prompt', {
      model: model.selectedModel.modelId,
      datasource: this.workspace.databaseInstance.name,
      systemPromptChars: prompt.length,
      messageCount: messages.length,
      messageChars,
      compressionLevel,
      charThreshold: QUERY_PROMPT_CHAR_THRESHOLD,
    });
    const content = await requestModelContent(model.endpoint, model.profile, model.selectedModel.modelId, prompt, messages);
    return { prompt, content };
  }
}

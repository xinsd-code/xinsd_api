import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { buildAiChatEndpoint } from '@/lib/ai-models';
import {
  AIModelSelection,
  ComputeNodeConfig,
  CustomParamDef,
  FilterNodeConfig,
  MapNodeConfig,
  OrchestrationConfig,
  OrchestrationNode,
  OrchestrationNodeType,
  ParamBinding,
  SortNodeConfig,
} from '@/lib/types';

export const runtime = 'nodejs';

type ChatRole = 'user' | 'assistant';
type ChatMode = 'general' | 'fix-validation';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ValidationIssueInput {
  severity: 'warning' | 'error';
  message: string;
  nodeId?: string;
}

interface ForwardConfigRef {
  method: string;
  path: string;
  targetType: 'mock' | 'api-client';
  targetId: string;
  paramBindings: ParamBinding[];
  customParams: CustomParamDef[];
}

interface AiChatRequestBody {
  messages: ChatMessage[];
  currentConfig: OrchestrationConfig;
  sampleOutput: unknown;
  customParams: CustomParamDef[];
  runParams?: Record<string, string>;
  forwardConfig: ForwardConfigRef;
  stream?: boolean;
  mode?: ChatMode;
  validationIssues?: ValidationIssueInput[];
  selectedModel?: AIModelSelection;
}

const NODE_LABELS: Record<OrchestrationNodeType, string> = {
  filter: '数据筛选',
  map: '字段映射',
  compute: '字段新增',
  sort: '排序限制',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createNodeId(index: number): string {
  return `ai_${Date.now().toString(36)}_${index.toString(36)}`;
}

function compactJson(value: unknown, maxLength = 18000): string {
  const text = JSON.stringify(value, null, 2);
  if (!text) return 'null';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

function parseJsonSafely(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text } };
  }
}

function extractJsonPayload(content: string): string {
  const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(start, end + 1);
  }

  throw new Error('AI 未返回可解析的 JSON 内容');
}

function sanitizeFilterConfig(config: unknown): FilterNodeConfig {
  const source = isRecord(config) ? config : {};
  const mode: FilterNodeConfig['mode'] = source.mode === 'exclude' ? 'exclude' : 'include';
  const fields = Array.isArray(source.fields)
    ? source.fields.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  return { mode, fields };
}

function sanitizeMapConfig(config: unknown): MapNodeConfig {
  const source = isRecord(config) ? config : {};
  const mappings = Array.isArray(source.mappings)
    ? source.mappings
        .filter(isRecord)
        .map((item) => ({
          from: typeof item.from === 'string' ? item.from.trim() : '',
          to: typeof item.to === 'string' ? item.to.trim() : '',
        }))
        .filter((item) => item.from && item.to)
    : [];

  return { mappings };
}

function sanitizeComputeConfig(config: unknown): ComputeNodeConfig {
  const source = isRecord(config) ? config : {};
  const computations = Array.isArray(source.computations)
    ? source.computations
        .filter(isRecord)
        .map((item) => ({
          field: typeof item.field === 'string' ? item.field.trim() : '',
          expression: typeof item.expression === 'string' ? item.expression.trim() : '',
          sourceField: typeof item.sourceField === 'string' ? item.sourceField.trim() : undefined,
        }))
        .filter((item) => item.field && (item.expression || item.sourceField))
    : [];

  return { computations };
}

function sanitizeSortConfig(config: unknown): SortNodeConfig {
  const source = isRecord(config) ? config : {};
  const rawLimit = typeof source.limit === 'number'
    ? source.limit
    : typeof source.limit === 'string'
      ? Number.parseInt(source.limit, 10)
      : undefined;

  return {
    arrayPath: typeof source.arrayPath === 'string' ? source.arrayPath.trim() : '',
    sortField: typeof source.sortField === 'string' ? source.sortField.trim() : '',
    order: (source.order === 'desc' ? 'desc' : 'asc') as SortNodeConfig['order'],
    limit: rawLimit && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
  };
}

function sanitizeNode(node: unknown, index: number): OrchestrationNode | null {
  if (!isRecord(node) || typeof node.type !== 'string') return null;

  const type = node.type as OrchestrationNodeType;
  if (!['filter', 'map', 'compute', 'sort'].includes(type)) return null;

  let config: OrchestrationNode['config'];
  switch (type) {
    case 'filter':
      config = sanitizeFilterConfig(node.config);
      break;
    case 'map':
      config = sanitizeMapConfig(node.config);
      break;
    case 'compute':
      config = sanitizeComputeConfig(node.config);
      break;
    case 'sort':
      config = sanitizeSortConfig(node.config);
      break;
  }

  return {
    id: typeof node.id === 'string' && node.id.trim() ? node.id : createNodeId(index),
    type,
    label: typeof node.label === 'string' && node.label.trim() ? node.label.trim() : NODE_LABELS[type],
    config,
    order: index,
  };
}

function sanitizeConfig(input: unknown): OrchestrationConfig {
  const rawConfig = isRecord(input) && Array.isArray(input.nodes)
    ? input.nodes
    : Array.isArray(input)
      ? input
      : [];

  const nodes = rawConfig
    .map((node, index) => sanitizeNode(node, index))
    .filter((node): node is OrchestrationNode => node !== null);

  return { nodes };
}

function buildBindingsText(bindings: ParamBinding[]): string {
  if (!bindings.length) return '[]';
  return JSON.stringify(
    bindings.map((binding) => ({
      targetParamKey: binding.targetParamKey,
      source: binding.customParamKey ? `customParam:${binding.customParamKey}` : 'static',
      staticValue: binding.staticValue ?? null,
    })),
    null,
    2
  );
}

let promptTemplateCache: string | null = null;

async function loadPromptTemplate(): Promise<string> {
  if (promptTemplateCache) return promptTemplateCache;
  const promptPath = path.join(process.cwd(), 'src/prompts/orchestration-ai-chat.md');
  promptTemplateCache = await readFile(promptPath, 'utf8');
  return promptTemplateCache;
}

function renderPromptTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((result, [key, value]) => {
    return result.replaceAll(`{{${key}}}`, value);
  }, template);
}

function buildPromptContext({
  currentConfig,
  sampleOutput,
  customParams,
  runParams,
  forwardConfig,
}: Omit<AiChatRequestBody, 'messages'>): string {
  return [
    '动态上下文如下：',
    '当前允许的工作流结构：',
    JSON.stringify(
      {
        configShape: {
          nodes: [
            {
              id: 'string',
              type: 'filter | map | compute | sort',
              label: 'string',
              order: 'number',
              config: 'depends on type',
            },
          ],
        },
        typeSchemas: {
          filter: { mode: 'include | exclude', fields: ['field.path', 'list[].field'] },
          map: { mappings: [{ from: 'field.path', to: 'field.path' }] },
          compute: {
            computations: [{ field: 'field.path | list[].field', expression: 'string', sourceField: 'string' }],
          },
          sort: { arrayPath: 'string', sortField: 'string', order: 'asc | desc', limit: 'number?' },
        },
      },
      null,
      2
    ),
    '',
    '当前转发配置：',
    compactJson({
      method: forwardConfig.method,
      path: forwardConfig.path,
      targetType: forwardConfig.targetType,
      targetId: forwardConfig.targetId,
    }, 3000),
    '',
    '当前入参定义（包含参数类型枚举、描述、默认值）：',
    compactJson(customParams, 5000),
    '',
    '当前预览入参值：',
    compactJson(runParams || {}, 3000),
    '',
    '目标接口参数绑定：',
    buildBindingsText(forwardConfig.paramBindings || []),
    '',
    '当前编排 scheme：',
    compactJson(currentConfig, 10000),
    '',
    '接口输出 output 示例：',
    compactJson(sampleOutput, 18000),
  ].join('\n');
}

function buildModePrompt(mode: ChatMode, validationIssues: ValidationIssueInput[]): string {
  if (mode === 'fix-validation') {
    return [
      '当前模式：只修复体检报错。',
      '你的目标是优先修复 validationIssues 中 severity = error 的问题，尽量少改动无关节点。',
      '如果能在顺手修复相关 warning 的前提下保持改动最小，也可以一起修。',
      '不要为了“优化”而重写整个工作流，除非当前工作流结构明显无法修复。',
      '需要重点参考以下体检问题：',
      compactJson(validationIssues, 8000),
    ].join('\n');
  }

  return '当前模式：常规生成/修改工作流。';
}

function getModelErrorMessage(upstreamJson: unknown): string {
  return isRecord(upstreamJson) && typeof upstreamJson.error === 'object' && upstreamJson.error && 'message' in upstreamJson.error
    ? String(upstreamJson.error.message)
    : '模型请求失败';
}

function buildUpstreamPayload(body: AiChatRequestBody, systemPrompt: string, stream: boolean) {
  return {
    model: body.selectedModel?.modelId || '',
    temperature: 0.2,
    stream,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...body.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };
}

function validateSelectedModel(input: unknown): AIModelSelection | null {
  if (!isRecord(input)) return null;
  if (
    typeof input.profileId !== 'string'
    || typeof input.profileName !== 'string'
    || typeof input.baseUrl !== 'string'
    || typeof input.modelId !== 'string'
  ) {
    return null;
  }

  const authType = input.authType === 'none' || input.authType === 'custom-header' ? input.authType : 'bearer';

  return {
    profileId: input.profileId.trim(),
    profileName: input.profileName.trim(),
    baseUrl: input.baseUrl.trim(),
    modelId: input.modelId.trim(),
    authType,
    authToken: typeof input.authToken === 'string' ? input.authToken.trim() : '',
    authHeaderName: typeof input.authHeaderName === 'string' ? input.authHeaderName.trim() : '',
    isDefault: input.isDefault === true,
  };
}

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as AiChatRequestBody;
    const selectedModel = validateSelectedModel(body.selectedModel);
    if (!selectedModel) {
      return NextResponse.json(
        { error: '请先在模型管理中配置并选择可用模型。' },
        { status: 400 }
      );
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const mode: ChatMode = body.mode === 'fix-validation' ? 'fix-validation' : 'general';
    const validationIssues = Array.isArray(body.validationIssues) ? body.validationIssues : [];
    const promptTemplate = await loadPromptTemplate();
    const contextPrompt = buildPromptContext(body);
    const modePrompt = buildModePrompt(mode, validationIssues);
    const systemPrompt = renderPromptTemplate(promptTemplate, {
      MODE_PROMPT: modePrompt,
      DYNAMIC_CONTEXT: contextPrompt,
    });
    const stream = body.stream === true;
    const endpoint = buildAiChatEndpoint(selectedModel.baseUrl);
    if (!endpoint) {
      return NextResponse.json({ error: '当前模型的 Base URL 无效。' }, { status: 400 });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (selectedModel.authType === 'bearer') {
      if (!selectedModel.authToken) {
        return NextResponse.json({ error: '当前模型缺少 Bearer Token。' }, { status: 400 });
      }
      headers.Authorization = `Bearer ${selectedModel.authToken}`;
    } else if (selectedModel.authType === 'custom-header') {
      if (!selectedModel.authHeaderName || !selectedModel.authToken) {
        return NextResponse.json({ error: '当前模型缺少自定义鉴权配置。' }, { status: 400 });
      }
      headers[selectedModel.authHeaderName] = selectedModel.authToken;
    }

    const upstreamRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildUpstreamPayload({ ...body, messages, selectedModel }, systemPrompt, stream)),
    });

    if (stream) {
      if (!upstreamRes.ok) {
        const upstreamText = await upstreamRes.text();
        const upstreamJson = parseJsonSafely(upstreamText);
        return NextResponse.json(
          { error: getModelErrorMessage(upstreamJson) },
          { status: upstreamRes.status }
        );
      }

      if (!upstreamRes.body) {
        return NextResponse.json({ error: 'AI 流式响应不可用' }, { status: 500 });
      }

      const upstreamBody = upstreamRes.body;

      const streamResponse = new ReadableStream<Uint8Array>({
        async start(controller) {
          const decoder = new TextDecoder();
          const reader = upstreamBody.getReader();
          let buffer = '';
          let accumulatedContent = '';

          const flushEvent = (rawEvent: string) => {
            const lines = rawEvent
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            const dataLines = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim());

            if (dataLines.length === 0) return;

            for (const payload of dataLines) {
              if (!payload || payload === '[DONE]') continue;

              const parsed = JSON.parse(payload);
              const choice = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
              const delta = isRecord(choice) && isRecord(choice.delta) && typeof choice.delta.content === 'string'
                ? choice.delta.content
                : '';

              if (delta) {
                accumulatedContent += delta;
                controller.enqueue(encodeSseEvent('delta', { content: delta }));
              }
            }
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value) continue;

              buffer += decoder.decode(value, { stream: true });

              let boundaryIndex = buffer.indexOf('\n\n');
              while (boundaryIndex !== -1) {
                const rawEvent = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + 2);
                flushEvent(rawEvent);
                boundaryIndex = buffer.indexOf('\n\n');
              }
            }

            if (buffer.trim()) {
              flushEvent(buffer);
            }

            const parsed = JSON.parse(extractJsonPayload(accumulatedContent));
            const message = isRecord(parsed) && typeof parsed.message === 'string'
              ? parsed.message
              : '已根据你的要求更新工作流配置。';
            const config = sanitizeConfig(isRecord(parsed) && 'config' in parsed ? parsed.config : parsed);

            controller.enqueue(encodeSseEvent('done', { message, config }));
          } catch (error) {
            controller.enqueue(
              encodeSseEvent('error', {
                error: error instanceof Error ? error.message : 'AI 流式响应处理失败',
              })
            );
          } finally {
            reader.releaseLock();
            controller.close();
          }
        },
      });

      return new Response(streamResponse, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    const upstreamText = await upstreamRes.text();
    const upstreamJson = parseJsonSafely(upstreamText);

    if (!upstreamRes.ok) {
      return NextResponse.json({ error: getModelErrorMessage(upstreamJson) }, { status: upstreamRes.status });
    }

    const content = isRecord(upstreamJson)
      && Array.isArray(upstreamJson.choices)
      && upstreamJson.choices.length > 0
      && isRecord(upstreamJson.choices[0])
      && isRecord(upstreamJson.choices[0].message)
      && typeof upstreamJson.choices[0].message.content === 'string'
      ? upstreamJson.choices[0].message.content
      : '';

    if (!content) {
      return NextResponse.json({ error: 'AI 未返回内容' }, { status: 500 });
    }

    const parsed = JSON.parse(extractJsonPayload(content));
    const message = isRecord(parsed) && typeof parsed.message === 'string'
      ? parsed.message
      : '已根据你的要求更新工作流配置。';
    const config = sanitizeConfig(isRecord(parsed) && 'config' in parsed ? parsed.config : parsed);

    return NextResponse.json({
      message,
      config,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'AI 编排请求失败' },
      { status: 500 }
    );
  }
}

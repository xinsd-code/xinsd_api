import { AIModelProfile, AIModelSelection, AIModelType, CreateAIModelProfile } from './types';

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function normalizeModelIds(modelIds: string[]): string[] {
  return Array.from(
    new Set(
      modelIds
        .map((modelId) => modelId.trim())
        .filter(Boolean)
    )
  );
}

export function buildAiChatEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

export function buildEmbeddingEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';
  return normalized.endsWith('/embeddings') ? normalized : `${normalized}/embeddings`;
}

export function buildAIModelEndpoint(baseUrl: string, modelType: AIModelType): string {
  return modelType === 'embedding' ? buildEmbeddingEndpoint(baseUrl) : buildAiChatEndpoint(baseUrl);
}

export function getAIModelTypeLabel(modelType: AIModelType): string {
  return modelType === 'embedding' ? 'Embedding' : '对话模型';
}

export function sanitizeAIModelProfileInput(input: Partial<CreateAIModelProfile>): CreateAIModelProfile {
  const modelIds = normalizeModelIds(Array.isArray(input.modelIds) ? input.modelIds : []);
  const requestedDefaultModelId = typeof input.defaultModelId === 'string' ? input.defaultModelId.trim() : '';
  const defaultModelId = modelIds.includes(requestedDefaultModelId)
    ? requestedDefaultModelId
    : (modelIds[0] || '');
  const authType = input.authType === 'custom-header' || input.authType === 'none' ? input.authType : 'bearer';
  const modelType = input.modelType === 'embedding' ? 'embedding' : 'chat';

  return {
    name: typeof input.name === 'string' ? input.name.trim() : '',
    modelType,
    baseUrl: normalizeBaseUrl(typeof input.baseUrl === 'string' ? input.baseUrl : ''),
    authType,
    authToken: typeof input.authToken === 'string' ? input.authToken.trim() : '',
    authHeaderName: typeof input.authHeaderName === 'string' ? input.authHeaderName.trim() : '',
    modelIds,
    defaultModelId,
    isDefault: input.isDefault === true,
  };
}

export function validateAIModelProfileInput(data: CreateAIModelProfile): string | null {
  if (!data.name) return '模型名称不能为空';
  if (!data.baseUrl) return 'Base URL 不能为空';
  if (!data.modelIds.length) return '请至少配置一个 Model ID';
  if (!data.defaultModelId) return '请选择默认 Model ID';
  if (!data.modelIds.includes(data.defaultModelId)) return '默认 Model ID 必须来自已配置列表';
  if (data.authType === 'bearer' && !data.authToken) return 'Bearer Token 不能为空';
  if (data.authType === 'custom-header') {
    if (!data.authHeaderName) return '自定义鉴权 Header 名称不能为空';
    if (!data.authToken) return '自定义鉴权值不能为空';
  }
  return null;
}

export function buildAIModelHeaders(input: Pick<CreateAIModelProfile, 'authType' | 'authToken' | 'authHeaderName'>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (input.authType === 'bearer') {
    headers.Authorization = `Bearer ${input.authToken}`;
  } else if (input.authType === 'custom-header' && input.authHeaderName) {
    headers[input.authHeaderName] = input.authToken || '';
  }

  return headers;
}

export function getAIModelValidationSignature(input: CreateAIModelProfile): string {
  return JSON.stringify({
    name: input.name,
    modelType: input.modelType,
    baseUrl: input.baseUrl,
    authType: input.authType,
    authToken: input.authToken,
    authHeaderName: input.authHeaderName,
    modelIds: input.modelIds,
    defaultModelId: input.defaultModelId,
    isDefault: input.isDefault,
  });
}

function getModelErrorMessage(upstreamJson: unknown): string {
  if (typeof upstreamJson === 'string' && upstreamJson.trim()) return upstreamJson.trim();
  if (
    upstreamJson
    && typeof upstreamJson === 'object'
    && 'error' in upstreamJson
    && upstreamJson.error
    && typeof upstreamJson.error === 'object'
    && 'message' in upstreamJson.error
  ) {
    return String(upstreamJson.error.message);
  }
  return '模型请求失败';
}

function parseJsonSafely(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function verifyAIModelAvailability(input: CreateAIModelProfile): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const endpoint = buildAIModelEndpoint(input.baseUrl, input.modelType);
  if (!endpoint) {
    return { ok: false, message: '当前模型的 Base URL 无效。' };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildAIModelHeaders(input),
      body: JSON.stringify(
        input.modelType === 'embedding'
          ? {
              model: input.defaultModelId,
              input: '衣服的质量杠杠的，很漂亮，不枉我等了这么久啊，喜欢，以后还来这里买',
              encoding_format: 'float',
            }
          : {
              model: input.defaultModelId,
              stream: false,
              temperature: 0,
              messages: [
                {
                  role: 'system',
                  content: 'You are a connection test assistant.',
                },
                {
                  role: 'user',
                  content: 'Reply with OK.',
                },
              ],
            }
      ),
    });

    const text = await response.text();
    const parsed = parseJsonSafely(text);

    if (!response.ok) {
      return {
        ok: false,
        message: getModelErrorMessage(parsed),
      };
    }

    return {
      ok: true,
      message: `${getAIModelTypeLabel(input.modelType)}连接测试通过：${input.defaultModelId}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '模型连接测试失败',
    };
  }
}

export function flattenAIModelSelections(
  profiles: AIModelProfile[],
  modelType?: AIModelType
): AIModelSelection[] {
  const targetProfiles = modelType ? profiles.filter((profile) => profile.modelType === modelType) : profiles;

  return targetProfiles.flatMap((profile) => (
    profile.modelIds.map((modelId) => ({
      profileId: profile.id,
      profileName: profile.name,
      modelType: profile.modelType,
      baseUrl: profile.baseUrl,
      authType: profile.authType,
      authToken: profile.authToken,
      authHeaderName: profile.authHeaderName,
      modelId,
      isDefault: profile.isDefault && profile.defaultModelId === modelId,
    }))
  ));
}

export function getDefaultAIModelSelection(
  profiles: AIModelProfile[],
  modelType?: AIModelType
): AIModelSelection | null {
  const selections = flattenAIModelSelections(profiles, modelType);
  return selections.find((item) => item.isDefault) || selections[0] || null;
}

export function getAIModelSelectionKey(selection: Pick<AIModelSelection, 'profileId' | 'modelId'>): string {
  return `${selection.profileId}::${selection.modelId}`;
}

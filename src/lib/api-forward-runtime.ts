import { getApiClientById, getDatabaseInstanceById, getDbApiById, getGroupVariables, getMockById } from './db';
import { applyOrchestration } from './orchestration-engine';
import { writeRedisCacheValue } from './redis-cache';
import { matchPath } from './matcher';
import { parseJsonBody, flattenJsonBody, JsonBodyField, buildJsonBodyFromFields } from './json-body';
import { resolveVariables } from './utils';
import { ApiForwardConfig, KeyValuePair } from './types';
import { buildRequestInputMap, executeDbApi } from './db-api';

export function findMatchingApiForward(
  forwards: ApiForwardConfig[],
  method: string,
  requestPath: string
): { config: ApiForwardConfig; pathParams: Record<string, string> } | null {
  for (const config of forwards) {
    if (config.method !== method.toUpperCase() && config.method !== '*') {
      continue;
    }

    const pathResult = matchPath(config.path, requestPath);
    if (!pathResult.matched) {
      continue;
    }

    return {
      config,
      pathParams: pathResult.params,
    };
  }

  return null;
}

function stringifyRuntimeValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export async function executeApiForwardRuntime(
  requestUrl: string,
  forwardConfig: ApiForwardConfig,
  runParams: Record<string, unknown>
) {
  let targetMethod = 'GET';
  let targetUrl = '';
  let targetHeaders: KeyValuePair[] = [];
  let targetParams: KeyValuePair[] = [];
  let targetBody = '';
  let apiGroup = '';

  if (forwardConfig.targetType === 'mock') {
    const mock = getMockById(forwardConfig.targetId);
    if (!mock) throw new Error('Target Mock API not found');
    const baseUrl = new URL(requestUrl).origin;
    targetUrl = `${baseUrl}/mock${mock.path.startsWith('/') ? mock.path : `/${mock.path}`}`;
    targetMethod = mock.method;
    targetHeaders = mock.requestHeaders || [];
    targetParams = mock.requestParams || [];
    targetBody = mock.requestBody || '';
    apiGroup = mock.apiGroup || '';
  } else if (forwardConfig.targetType === 'api-client') {
    const client = getApiClientById(forwardConfig.targetId);
    if (!client) throw new Error('Target API Client not found');
    targetUrl = client.url;
    targetMethod = client.method;
    targetHeaders = client.requestHeaders || [];
    targetParams = client.requestParams || [];
    targetBody = client.requestBody || '';
    apiGroup = client.apiGroup || '';
  } else {
    const dbApi = getDbApiById(forwardConfig.targetId);
    if (!dbApi) throw new Error('Target DB API not found');
    const instance = getDatabaseInstanceById(dbApi.databaseInstanceId);
    if (!instance || (instance.type !== 'mysql' && instance.type !== 'pgsql')) {
      throw new Error('Target DB API database instance not found');
    }

    const dbApiInput = buildRequestInputMap({}, new URLSearchParams(), runParams);
    const execution = await executeDbApi(dbApi, instance, dbApiInput);
    const responsePayload = {
      data: execution.result.rows,
      columns: execution.result.columns,
      summary: execution.result.summary,
    };
    let finalData: unknown = responsePayload;

    if (forwardConfig.orchestration?.nodes?.length) {
      finalData = applyOrchestration(
        responsePayload,
        forwardConfig.orchestration,
        Object.fromEntries(
          Object.entries(runParams).map(([key, value]) => [key, stringifyRuntimeValue(value)])
        )
      );
    }

    const cacheResult = await writeRedisCacheValue(
      forwardConfig.id,
      forwardConfig.redisConfig,
      runParams,
      finalData
    );

    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      data: finalData,
      meta: {
        forwardMethod: dbApi.method,
        forwardUrl: dbApi.path,
        forwardHeaders: {},
        orchestrationApplied: !!forwardConfig.orchestration?.nodes?.length,
        cache: cacheResult,
        targetType: 'db-api',
        dbApi: {
          id: dbApi.id,
          name: dbApi.name,
          databaseInstanceId: dbApi.databaseInstanceId,
          previewSql: execution.debug.previewSql,
          resolvedBindings: execution.debug.resolvedBindings,
          summary: execution.result.summary,
        },
      },
    };
  }

  const groupVars = apiGroup ? getGroupVariables(apiGroup) : [];
  const finalParams = [...targetParams].map((param) => ({ ...param }));
  const resolvedTargetBodyTemplate = resolveVariables(targetBody, groupVars);
  const parsedTargetBody = parseJsonBody(resolvedTargetBodyTemplate);
  const finalBodyFields: JsonBodyField[] =
    parsedTargetBody.error || parsedTargetBody.data === null
      ? []
      : flattenJsonBody(parsedTargetBody.data).map((field) => ({ ...field }));

  const upsertBodyField = (path: string, value: string) => {
    const existingField = finalBodyFields.find((field) => field.path === path);
    if (existingField) {
      existingField.value = value;
      return;
    }

    finalBodyFields.push({
      path,
      type: 'string',
      value,
    });
  };

  for (const binding of forwardConfig.paramBindings || []) {
    let nextValue: string | undefined;
    if (binding.staticValue !== undefined) {
      nextValue = binding.staticValue;
    } else if (binding.customParamKey) {
      nextValue = stringifyRuntimeValue(runParams[binding.customParamKey]);
    }

    if (nextValue === undefined) {
      continue;
    }

    if (binding.targetLocation === 'body') {
      upsertBodyField(binding.targetParamKey, nextValue);
      continue;
    }

    const targetParamIndex = finalParams.findIndex((param) => param.key === binding.targetParamKey);
    if (targetParamIndex !== -1) {
      finalParams[targetParamIndex].value = nextValue;
    } else {
      finalParams.push({
        key: binding.targetParamKey,
        value: nextValue,
      });
    }
  }

  const resolvedUrl = resolveVariables(targetUrl, groupVars);
  const urlObj = new URL(resolvedUrl);
  for (const param of finalParams) {
    if (param.key) {
      urlObj.searchParams.append(param.key, resolveVariables(param.value || '', groupVars));
    }
  }

  const headers = new Headers();
  for (const header of targetHeaders) {
    if (header.key) {
      headers.append(header.key, resolveVariables(header.value || '', groupVars));
    }
  }

  if (!headers.has('Content-Type') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(targetMethod)) {
    headers.set('Content-Type', 'application/json');
  }

  let bodyPayload: BodyInit | null = null;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(targetMethod) && (resolvedTargetBodyTemplate || finalBodyFields.length > 0)) {
    if (finalBodyFields.length > 0 || (!parsedTargetBody.error && parsedTargetBody.data !== null)) {
      bodyPayload = JSON.stringify(buildJsonBodyFromFields(finalBodyFields));
    } else {
      bodyPayload = resolvedTargetBodyTemplate;
    }
  }

  const response = await fetch(urlObj.toString(), {
    method: targetMethod,
    headers,
    body: bodyPayload,
    cache: 'no-store',
  });

  const responseStatus = response.status;
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get('content-type') || '';

  let responseData: unknown;
  if (contentType.includes('application/json')) {
    try {
      responseData = await response.json();
    } catch {
      const textData = await response.text();
      responseData = { text: textData, _parseError: 'Invalid JSON response payload' };
    }
  } else {
    responseData = await response.text();
  }

  let finalData = responseData;
  if (forwardConfig.orchestration?.nodes?.length) {
    finalData = applyOrchestration(responseData, forwardConfig.orchestration, Object.fromEntries(
      Object.entries(runParams).map(([key, value]) => [key, stringifyRuntimeValue(value)])
    ));
  }

  const cacheResult = await writeRedisCacheValue(
    forwardConfig.id,
    forwardConfig.redisConfig,
    runParams,
    finalData
  );

  return {
    status: responseStatus,
    headers: responseHeaders,
    data: finalData,
    meta: {
      forwardMethod: targetMethod,
      forwardUrl: urlObj.toString(),
      forwardHeaders: Object.fromEntries(headers.entries()),
      orchestrationApplied: !!forwardConfig.orchestration?.nodes?.length,
      cache: cacheResult,
    },
  };
}

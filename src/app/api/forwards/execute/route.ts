import { NextResponse } from 'next/server';
import { ApiForwardConfig, KeyValuePair } from '@/lib/types';
import { applyOrchestration } from '@/lib/orchestration-engine';
import { getMockById, getApiClientById } from '@/lib/db';
import { resolveVariables } from '@/lib/utils';
import { getGroupVariables } from '@/lib/db';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { forwardConfig, runParams } = body as { forwardConfig: ApiForwardConfig, runParams: Record<string, string> };

    // 1. Resolve Target Interface
    let targetMethod = 'GET';
    let targetUrl = '';
    let targetHeaders: KeyValuePair[] = [];
    let targetParams: KeyValuePair[] = [];
    let targetBody = '';
    let apiGroup = '';

    if (forwardConfig.targetType === 'mock') {
      const mock = getMockById(forwardConfig.targetId);
      if (!mock) throw new Error('Target Mock API not found');
      // For mock, the URL is local
      const baseUrl = new URL(request.url).origin;
      targetUrl = `${baseUrl}/mock${mock.path.startsWith('/') ? mock.path : '/' + mock.path}`;
      targetMethod = mock.method;
      targetHeaders = mock.requestHeaders || [];
      targetParams = mock.requestParams || [];
      apiGroup = mock.apiGroup || '';
    } else {
      const client = getApiClientById(forwardConfig.targetId);
      if (!client) throw new Error('Target API Client not found');
      targetUrl = client.url;
      targetMethod = client.method;
      targetHeaders = client.requestHeaders || [];
      targetParams = client.requestParams || [];
      targetBody = client.requestBody || '';
      apiGroup = client.apiGroup || '';
    }

    // 2. Fetch Group Variables for environmental replacement
    const groupVars = apiGroup ? getGroupVariables(apiGroup) : [];

    // 3. Map custom parameters -> target parameters using bindings
    // Deep clone target params to override values
    const finalParams = [...targetParams].map(p => ({ ...p }));
    
    for (const binding of forwardConfig.paramBindings || []) {
      const targetParamIndex = finalParams.findIndex(p => p.key === binding.targetParamKey);
      if (targetParamIndex !== -1) {
        if (binding.staticValue !== undefined) {
          // Use static value
          finalParams[targetParamIndex].value = binding.staticValue;
        } else if (binding.customParamKey) {
          // Map from custom param
          const val = runParams[binding.customParamKey];
          if (val !== undefined) {
            finalParams[targetParamIndex].value = val;
          }
        }
      }
    }

    // 4. Construct URL Query params
    const resolvedUrl = resolveVariables(targetUrl, groupVars);
    const urlObj = new URL(resolvedUrl);
    
    // Add evaluated params to URL
    for (const p of finalParams) {
      if (p.key) {
        // Evaluate grouped variables in param values just in case
        const pValue = resolveVariables(p.value || '', groupVars);
        urlObj.searchParams.append(p.key, pValue);
      }
    }

    // 5. Construct Headers
    const headers = new Headers();
    for (const h of targetHeaders) {
      if (h.key) {
        headers.append(h.key, resolveVariables(h.value || '', groupVars));
      }
    }

    // Add required headers if none present
    if (!headers.has('Content-Type') && ['POST', 'PUT', 'PATCH'].includes(targetMethod)) {
      headers.set('Content-Type', 'application/json');
    }

    // 6. Construct Body (if applicable)
    let bodyPayload: BodyInit | null = null;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(targetMethod) && targetBody) {
      bodyPayload = resolveVariables(targetBody, groupVars);
    }

    // 7. Make the actual proxy fetch call!
    const response = await fetch(urlObj.toString(), {
      method: targetMethod,
      headers,
      body: bodyPayload,
      cache: 'no-store'
    });

    const responseStatus = response.status;
    const responseHeaders = Object.fromEntries(response.headers.entries());
    
    // Attempt to parse response as JSON
    let responseData: unknown;
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      try {
        responseData = await response.json();
      } catch {
        const textData = await response.text();
        responseData = { text: textData, _parseError: "Invalid JSON response payload" };
      }
    } else {
      responseData = await response.text();
    }

    // 8. Apply orchestration if configured
    let finalData = responseData;
    if (forwardConfig.orchestration && forwardConfig.orchestration.nodes && forwardConfig.orchestration.nodes.length > 0) {
      try {
        finalData = applyOrchestration(responseData, forwardConfig.orchestration, runParams);
      } catch (orchError) {
        return NextResponse.json({
          _meta: {
            forwardMethod: targetMethod,
            forwardUrl: urlObj.toString(),
            forwardHeaders: Object.fromEntries(headers.entries()),
          },
          status: responseStatus,
          headers: responseHeaders,
          data: responseData,
          _orchestrationError: orchError instanceof Error ? orchError.message : 'Orchestration failed',
        });
      }
    }

    // 9. Return result back to our platform UI
    return NextResponse.json({
      _meta: {
        forwardMethod: targetMethod,
        forwardUrl: urlObj.toString(),
        forwardHeaders: Object.fromEntries(headers.entries()),
        orchestrationApplied: !!(forwardConfig.orchestration?.nodes?.length),
      },
      status: responseStatus,
      headers: responseHeaders,
      data: finalData
    });

  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Execution failed' },
      { status: 500 }
    );
  }
}

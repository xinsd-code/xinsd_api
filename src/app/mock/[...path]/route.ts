import { NextRequest, NextResponse } from 'next/server';
import { getEnabledMocks, getGroupVariables } from '@/lib/db';
import { findMatchingMock } from '@/lib/matcher';
import { resolveVariables } from '@/lib/utils';

async function handleMockRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: pathSegments } = await params;
    const requestPath = '/' + pathSegments.join('/');
    const method = request.method;

    // Get all enabled mocks
    const mocks = getEnabledMocks();

    // Collect request headers
    const requestHeaders: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      requestHeaders[key] = value;
    });

    // Collect request params (query + body)
    const requestParams: Record<string, string> = {};
    const url = new URL(request.url);
    url.searchParams.forEach((value, key) => {
      requestParams[key] = value;
    });

    // Try to parse body params for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        const contentType = request.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const body = await request.clone().json();
          if (typeof body === 'object' && body !== null) {
            for (const [key, value] of Object.entries(body)) {
              requestParams[key] = String(value);
            }
          }
        }
      } catch {
        // Ignore body parse errors
      }
    }

    // Find matching mock
    const result = findMatchingMock(mocks, method, requestPath, requestHeaders, requestParams);

    if (!result) {
      return NextResponse.json(
        {
          error: 'No matching mock found',
          path: requestPath,
          method,
          hint: 'Create a mock API configuration matching this path and method',
        },
        { status: 404 }
      );
    }

    const { mock, pathParams } = result;

    const groupVars = getGroupVariables(mock.apiGroup || '未分组');

    // Apply response delay
    if (mock.responseDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, mock.responseDelay));
    }

    // Handle streaming response (SSE)
    if (mock.isStream && mock.streamConfig.chunks.length > 0) {
      return handleStreamResponse(mock.streamConfig.chunks, mock.streamConfig.chunkDelay, mock.responseHeaders, pathParams, groupVars);
    }

    // Build response body with path params substitution
    let responseBody = mock.responseBody;
    responseBody = resolveVariables(responseBody, groupVars);
    for (const [key, value] of Object.entries(pathParams)) {
      responseBody = responseBody.replace(new RegExp(`:${key}`, 'g'), value);
      responseBody = responseBody.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }

    // Build response headers
    const headers: Record<string, string> = {};
    for (const { key, value } of mock.responseHeaders) {
      if (key) headers[key] = resolveVariables(value, groupVars);
    }

    // Try to parse as JSON, fallback to plain text
    try {
      const jsonBody = JSON.parse(responseBody);
      return NextResponse.json(jsonBody, {
        status: mock.responseStatus,
        headers,
      });
    } catch {
      return new NextResponse(responseBody, {
        status: mock.responseStatus,
        headers: {
          'Content-Type': 'text/plain',
          ...headers,
        },
      });
    }
  } catch (error) {
    console.error('Mock service error:', error);
    return NextResponse.json(
      { error: 'Internal mock service error' },
      { status: 500 }
    );
  }
}

function handleStreamResponse(
  chunks: string[],
  chunkDelay: number,
  responseHeaders: { key: string; value: string }[],
  pathParams: Record<string, string>,
  groupVars: import('@/lib/types').KeyValuePair[]
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i];
        chunk = resolveVariables(chunk, groupVars);
        // Substitute path params
        for (const [key, value] of Object.entries(pathParams)) {
          chunk = chunk.replace(new RegExp(`:${key}`, 'g'), value);
          chunk = chunk.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        }

        const sseData = `data: ${chunk}\n\n`;
        controller.enqueue(encoder.encode(sseData));

        if (i < chunks.length - 1 && chunkDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, chunkDelay));
        }
      }

      // Send done event
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
  for (const { key, value } of responseHeaders) {
    if (key) headers[key] = resolveVariables(value, groupVars);
  }

  return new NextResponse(stream, { headers });
}

// Support all HTTP methods
export const GET = handleMockRequest;
export const POST = handleMockRequest;
export const PUT = handleMockRequest;
export const DELETE = handleMockRequest;
export const PATCH = handleMockRequest;
export const OPTIONS = handleMockRequest;
export const HEAD = handleMockRequest;

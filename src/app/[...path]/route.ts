import { NextRequest, NextResponse } from 'next/server';
import {
  getAllApiForwards,
  getAllDbApis,
  getDatabaseInstanceById,
} from '@/lib/db';
import { executeApiForwardRuntime, findMatchingApiForward } from '@/lib/api-forward-runtime';
import { buildRequestInputMap, executeDbApi, findMatchingDbApi } from '@/lib/db-api';
import { writeRedisCacheValue } from '@/lib/redis-cache';

export const dynamic = 'force-dynamic';

const RESERVED_PREFIXES = ['/api/', '/_next/'];
const RESERVED_PATHS = new Set(['/api', '/_next', '/favicon.ico', '/robots.txt', '/sitemap.xml']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function parseRequestBody(request: NextRequest): Promise<unknown> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    return null;
  }

  const contentType = request.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      return await request.clone().json();
    }

    if (
      contentType.includes('application/x-www-form-urlencoded')
      || contentType.includes('multipart/form-data')
    ) {
      const form = await request.clone().formData();
      return Object.fromEntries(form.entries());
    }
  } catch {
    return null;
  }

  return null;
}

function isReservedPath(pathname: string): boolean {
  if (RESERVED_PATHS.has(pathname)) {
    return true;
  }

  return RESERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function buildResponseHeaders(
  sourceHeaders?: Record<string, string>,
  options?: { json?: boolean; extras?: Record<string, string> }
) {
  const headers = new Headers();

  Object.entries(sourceHeaders || {}).forEach(([key, value]) => {
    if (!key || value === undefined || value === null) {
      return;
    }

    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
      return;
    }

    if (options?.json && lowerKey === 'content-type') {
      return;
    }

    headers.set(key, value);
  });

  Object.entries(options?.extras || {}).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return headers;
}

function buildRuntimeResponse(
  payload: unknown,
  status: number,
  headers: Headers
) {
  if (typeof payload === 'string') {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'text/plain; charset=utf-8');
    }

    return new NextResponse(payload, { status, headers });
  }

  return NextResponse.json(payload ?? null, { status, headers });
}

async function handleDirectConfiguredRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const requestPath = `/${(path || []).join('/')}`;

    if (isReservedPath(requestPath)) {
      return NextResponse.json({ error: 'Not Found' }, { status: 404 });
    }

    const requestBody = await parseRequestBody(request);
    const searchParams = request.nextUrl.searchParams;

    const forwardMatch = findMatchingApiForward(getAllApiForwards(), request.method, requestPath);
    if (forwardMatch) {
      const inputValues = buildRequestInputMap(forwardMatch.pathParams, searchParams, requestBody);
      const execution = await executeApiForwardRuntime(request.url, forwardMatch.config, inputValues);
      const responseHeaders = buildResponseHeaders(execution.headers, {
        json: typeof execution.data !== 'string',
        extras: {
          'X-API-Forward-ID': forwardMatch.config.id,
          'X-API-Forward-Name': encodeURIComponent(forwardMatch.config.name),
          'X-API-Forward-Cache': execution.meta.cache.ok
            ? 'written'
            : execution.meta.cache.enabled
              ? 'failed'
              : 'disabled',
        },
      });

      return buildRuntimeResponse(execution.data, execution.status, responseHeaders);
    }

    const dbApiMatch = findMatchingDbApi(getAllDbApis(), request.method, requestPath);
    if (dbApiMatch) {
      const instance = getDatabaseInstanceById(dbApiMatch.config.databaseInstanceId);
      if (!instance || (instance.type !== 'mysql' && instance.type !== 'pgsql')) {
        return NextResponse.json({ error: '绑定的数据源不存在或不支持 SQL' }, { status: 400 });
      }

      const inputValues = buildRequestInputMap(dbApiMatch.pathParams, searchParams, requestBody);
      const execution = await executeDbApi(dbApiMatch.config, instance, inputValues);
      const responsePayload = {
        data: execution.result.rows,
        columns: execution.result.columns,
        summary: execution.result.summary,
      };
      const cacheResult = await writeRedisCacheValue(
        dbApiMatch.config.id,
        dbApiMatch.config.redisConfig,
        inputValues,
        responsePayload
      );

      return NextResponse.json(responsePayload, {
        status: 200,
        headers: buildResponseHeaders(undefined, {
          extras: {
            'X-DB-API-ID': dbApiMatch.config.id,
            'X-DB-API-Name': encodeURIComponent(dbApiMatch.config.name),
            'X-DB-API-Cache': cacheResult.ok ? 'written' : cacheResult.enabled ? 'failed' : 'disabled',
          },
        }),
      });
    }

    return NextResponse.json(
      {
        error: 'No matching configured endpoint found',
        path: requestPath,
        method: request.method,
      },
      { status: 404 }
    );
  } catch (error) {
    console.error('Configured endpoint runtime error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '接口运行失败' },
      { status: 500 }
    );
  }
}

export const GET = handleDirectConfiguredRequest;
export const POST = handleDirectConfiguredRequest;
export const PUT = handleDirectConfiguredRequest;
export const PATCH = handleDirectConfiguredRequest;
export const DELETE = handleDirectConfiguredRequest;
export const OPTIONS = handleDirectConfiguredRequest;
export const HEAD = handleDirectConfiguredRequest;

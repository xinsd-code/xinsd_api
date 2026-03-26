import { NextRequest, NextResponse } from 'next/server';
import { getAllDbApis, getDatabaseInstanceById } from '@/lib/db';
import { buildRequestInputMap, executeDbApi, findMatchingDbApi } from '@/lib/db-api';
import { writeRedisCacheValue } from '@/lib/redis-cache';

async function parseRequestBody(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') || '';
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    return null;
  }

  try {
    if (contentType.includes('application/json')) {
      return await request.clone().json();
    }

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await request.clone().formData();
      return Object.fromEntries(form.entries());
    }
  } catch {
    return null;
  }

  return null;
}

async function handleDbApiRequest(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const requestPath = `/${path.join('/')}`;
    const match = findMatchingDbApi(getAllDbApis(), request.method, requestPath);

    if (!match) {
      return NextResponse.json(
        {
          error: 'No matching DB API found',
          path: requestPath,
          method: request.method,
        },
        { status: 404 }
      );
    }

    const instance = getDatabaseInstanceById(match.config.databaseInstanceId);
    if (!instance || (instance.type !== 'mysql' && instance.type !== 'pgsql')) {
      return NextResponse.json({ error: '绑定的数据源不存在或不支持 SQL' }, { status: 400 });
    }

    const body = await parseRequestBody(request);
    const inputValues = buildRequestInputMap(match.pathParams, new URL(request.url).searchParams, body);
    const execution = await executeDbApi(match.config, instance, inputValues);
    const responsePayload = {
      data: execution.result.rows,
      columns: execution.result.columns,
      summary: execution.result.summary,
    };
    const cacheResult = await writeRedisCacheValue(
      match.config.id,
      match.config.redisConfig,
      inputValues,
      responsePayload
    );

    return NextResponse.json(
      responsePayload,
      {
        status: 200,
        headers: {
          'X-DB-API-ID': match.config.id,
          'X-DB-API-Name': encodeURIComponent(match.config.name),
          'X-DB-API-Cache': cacheResult.ok ? 'written' : cacheResult.enabled ? 'failed' : 'disabled',
        },
      }
    );
  } catch (error) {
    console.error('DB API runtime error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'DB API 运行失败' },
      { status: 500 }
    );
  }
}

export const GET = handleDbApiRequest;
export const POST = handleDbApiRequest;
export const PUT = handleDbApiRequest;
export const PATCH = handleDbApiRequest;
export const DELETE = handleDbApiRequest;

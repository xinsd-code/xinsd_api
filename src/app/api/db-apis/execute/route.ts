import { NextResponse } from 'next/server';
import { getDatabaseInstanceById } from '@/lib/db';
import { executeDbApi } from '@/lib/db-api';
import { DbApiConfig } from '@/lib/types';
import { writeRedisCacheValue } from '@/lib/redis-cache';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { config, runParams, previewLimit } = body as {
      config: DbApiConfig;
      runParams: Record<string, unknown>;
      previewLimit?: number;
    };

    const instance = getDatabaseInstanceById(config.databaseInstanceId);
    if (!instance || (instance.type !== 'mysql' && instance.type !== 'pgsql')) {
      return NextResponse.json({ error: '请选择有效的 SQL 数据源' }, { status: 400 });
    }

    const execution = await executeDbApi(config, instance, runParams || {}, { previewLimit });
    const responsePayload = {
      columns: execution.result.columns,
      rows: execution.result.rows,
      summary: execution.result.summary,
    };
    const cacheResult = await writeRedisCacheValue(
      config.id,
      config.redisConfig,
      runParams || {},
      responsePayload
    );

    return NextResponse.json({
      _meta: {
        ...execution.debug,
        cache: cacheResult,
      },
      ...execution.result,
    });
  } catch (error) {
    console.error('Failed to execute DB API:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '执行 DB API 失败' },
      { status: 400 }
    );
  }
}

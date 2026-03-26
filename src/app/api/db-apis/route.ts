import { NextResponse } from 'next/server';
import { createDbApi, getAllDbApisSummary, getDatabaseInstanceById } from '@/lib/db';
import { sanitizeDbApiInput, validateDbApiInput } from '@/lib/db-api';
import { sanitizeRedisCacheConfig, validateRedisCacheConfig } from '@/lib/redis-cache-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getAllDbApisSummary());
  } catch (error) {
    console.error('Failed to get DB APIs:', error);
    return NextResponse.json({ error: '获取 DB API 列表失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = sanitizeDbApiInput(body);
    const validationError = validateDbApiInput(data);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const instance = getDatabaseInstanceById(data.databaseInstanceId);
    if (!instance || (instance.type !== 'mysql' && instance.type !== 'pgsql')) {
      return NextResponse.json({ error: '请选择可执行 SQL 的数据源（MySQL / PostgreSQL）' }, { status: 400 });
    }

    const redisConfig = sanitizeRedisCacheConfig(data.redisConfig);
    const redisValidationError = validateRedisCacheConfig(redisConfig);
    if (redisValidationError) {
      return NextResponse.json({ error: redisValidationError }, { status: 400 });
    }
    if (redisConfig.enabled) {
      const redisInstance = getDatabaseInstanceById(redisConfig.instanceId!);
      if (!redisInstance || redisInstance.type !== 'redis') {
        return NextResponse.json({ error: '请选择有效的 Redis 数据源' }, { status: 400 });
      }
    }

    const created = createDbApi({
      ...data,
      redisConfig,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Failed to create DB API:', error);
    return NextResponse.json({ error: '创建 DB API 失败' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { deleteDbApi, getDatabaseInstanceById, getDbApiById, updateDbApi } from '@/lib/db';
import { sanitizeDbApiInput, validateDbApiInput } from '@/lib/db-api';
import { sanitizeRedisCacheConfig, validateRedisCacheConfig } from '@/lib/redis-cache-config';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const config = getDbApiById(id);
    if (!config) {
      return NextResponse.json({ error: 'DB API 不存在' }, { status: 404 });
    }
    return NextResponse.json(config);
  } catch (error) {
    console.error('Failed to get DB API:', error);
    return NextResponse.json({ error: '获取 DB API 失败' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = getDbApiById(id);
    if (!existing) {
      return NextResponse.json({ error: 'DB API 不存在' }, { status: 404 });
    }

    const body = await request.json();
    const data = sanitizeDbApiInput({
      ...existing,
      ...body,
    });
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

    const updated = updateDbApi(id, {
      ...data,
      redisConfig,
    });
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update DB API:', error);
    return NextResponse.json({ error: '更新 DB API 失败' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const success = deleteDbApi(id);
    if (!success) {
      return NextResponse.json({ error: 'DB API 不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete DB API:', error);
    return NextResponse.json({ error: '删除 DB API 失败' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { getApiForwardById, updateApiForward, deleteApiForward, getDatabaseInstanceById } from '@/lib/db';
import { sanitizeRedisCacheConfig, validateRedisCacheConfig } from '@/lib/redis-cache-config';
import { UpdateApiForwardConfig } from '@/lib/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await params;
    const forward = getApiForwardById(resolvedParams.id);
    if (!forward) {
      return NextResponse.json({ error: 'API Forward not found' }, { status: 404 });
    }
    return NextResponse.json(forward);
  } catch (error) {
    console.error('Failed to get API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await params;
    const data: UpdateApiForwardConfig = await request.json();
    let redisConfig = data.redisConfig;

    if (data.redisConfig !== undefined) {
      redisConfig = sanitizeRedisCacheConfig(data.redisConfig);
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
    }
    
    const forward = updateApiForward(resolvedParams.id, {
      ...data,
      redisConfig,
    });
    
    if (!forward) {
      return NextResponse.json({ error: 'API Forward not found' }, { status: 404 });
    }
    
    return NextResponse.json(forward);
  } catch (error) {
    console.error('Failed to update API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await params;
    const success = deleteApiForward(resolvedParams.id);
    if (!success) {
      return NextResponse.json({ error: 'API Forward not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

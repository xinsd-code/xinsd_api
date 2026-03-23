import { NextResponse } from 'next/server';
import { getAllApiForwardsSummary, createApiForward, getDatabaseInstanceById } from '@/lib/db';
import { sanitizeRedisCacheConfig, validateRedisCacheConfig } from '@/lib/redis-cache-config';
import { CreateApiForwardConfig } from '@/lib/types';

export async function GET() {
  try {
    const forwards = getAllApiForwardsSummary();
    return NextResponse.json(forwards);
  } catch (error) {
    console.error('Failed to get API forwards:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data: CreateApiForwardConfig = await request.json();
    
    // Validate required fields
    if (!data.name || !data.path || !data.method || !data.targetType || !data.targetId) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
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

    const newForward = createApiForward({
      ...data,
      redisConfig,
    });
    return NextResponse.json(newForward, { status: 201 });
  } catch (error) {
    console.error('Failed to create API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

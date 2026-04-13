import { NextResponse } from 'next/server';
import { getDatabaseInstanceById, updateDatabaseInstance } from '@/lib/db';
import { sanitizeDatabaseMetricMappings } from '@/lib/database-instances';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { deriveSemanticSnapshot } from '@/lib/db-harness/tools/catalog-tools';

export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = getDatabaseInstanceById(id);
    if (!existing) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    if (existing.type === 'redis') {
      return NextResponse.json({ error: 'Redis 实例不支持指标映射' }, { status: 400 });
    }

    const body = await request.json();
    const metricMappings = sanitizeDatabaseMetricMappings(body?.metricMappings);
    const schema = await getDatabaseSchema(existing);
    const semanticModel = {
      ...deriveSemanticSnapshot(schema, metricMappings),
      source: 'generated' as const,
      updatedAt: new Date().toISOString(),
    };
    const updated = updateDatabaseInstance(id, { metricMappings, semanticModel });
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update database metric mappings:', error);
    return NextResponse.json({ error: '更新指标映射失败' }, { status: 500 });
  }
}

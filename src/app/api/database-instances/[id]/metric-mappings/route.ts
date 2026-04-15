import { NextResponse } from 'next/server';
import { getDatabaseInstanceById, updateDatabaseInstance } from '@/lib/db';
import { sanitizeDatabaseMetricMappings } from '@/lib/database-instances';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { deriveSemanticSnapshot } from '@/lib/db-harness/tools/catalog-tools';
import { requireSession, verifyDatabaseInstanceAccess } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const existing = getDatabaseInstanceById(id);
    if (!existing) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    // Verify access
    const hasAccess = await verifyDatabaseInstanceAccess(
      existing.workspaceId || 'default-workspace',
      existing.ownerId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to update database metric mappings:', error);
    return NextResponse.json({ error: '更新指标映射失败' }, { status: 500 });
  }
}

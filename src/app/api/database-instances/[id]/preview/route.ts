import { NextResponse } from 'next/server';
import { getDatabaseInstanceById } from '@/lib/db';
import { getDatabaseCollectionPreview } from '@/lib/database-instances-server';
import { requireSession, verifyDatabaseInstanceAccess } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const instance = getDatabaseInstanceById(id);
    if (!instance) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    // Verify access
    const hasAccess = await verifyDatabaseInstanceAccess(
      instance.workspaceId || 'default-workspace',
      instance.ownerId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name')?.trim();
    if (!name) {
      return NextResponse.json({ error: '缺少要预览的表名或 Key 名' }, { status: 400 });
    }

    const preview = await getDatabaseCollectionPreview(instance, name);
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to preview database collection:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取数据预览失败' }, { status: 500 });
  }
}

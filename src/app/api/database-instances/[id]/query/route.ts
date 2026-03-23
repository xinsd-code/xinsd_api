import { NextResponse } from 'next/server';
import { getDatabaseInstanceById } from '@/lib/db';
import { executeDatabaseQuery } from '@/lib/database-instances-server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const instance = getDatabaseInstanceById(id);
    if (!instance) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    const body = await request.json();
    const query = typeof body?.query === 'string' ? body.query : '';
    const result = await executeDatabaseQuery(instance, query);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to execute database query:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '执行查询失败' }, { status: 400 });
  }
}

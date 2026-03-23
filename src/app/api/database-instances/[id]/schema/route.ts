import { NextResponse } from 'next/server';
import { getDatabaseInstanceById } from '@/lib/db';
import { getDatabaseSchema } from '@/lib/database-instances-server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const instance = getDatabaseInstanceById(id);
    if (!instance) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    const schema = await getDatabaseSchema(instance);
    return NextResponse.json(schema);
  } catch (error) {
    console.error('Failed to get database schema:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取数据库结构失败' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { requireSession, verifyDatabaseInstanceAccess } from '@/lib/auth';
import { getDatabaseInstanceById } from '@/lib/db';
import { executeNl2DataSql, getNl2DataErrorMessage } from '@/lib/nl2data/executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // 验证用户已认证
    const session = await requireSession();

    const body = await request.json() as { databaseInstanceId?: string; sql?: string };
    if (!body.databaseInstanceId) {
      return NextResponse.json({ error: '请先选择数据源。' }, { status: 400 });
    }
    if (!body.sql?.trim()) {
      return NextResponse.json({ error: '请输入要执行的 SQL。' }, { status: 400 });
    }

    // 验证用户对数据库实例的访问权限
    const instance = getDatabaseInstanceById(body.databaseInstanceId);
    if (instance) {
      const hasAccess = await verifyDatabaseInstanceAccess(
        instance.workspaceId || 'default-workspace',
        instance.ownerId
      );
      if (!hasAccess) {
        return NextResponse.json(
          { error: '您没有权限访问此数据源' },
          { status: 403 }
        );
      }
    }

    const result = await executeNl2DataSql(body.databaseInstanceId, body.sql.trim());
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to execute NL2DATA SQL:', error);
    return NextResponse.json(
      { error: getNl2DataErrorMessage(error) },
      { status: 500 }
    );
  }
}

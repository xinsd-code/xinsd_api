import { NextResponse } from 'next/server';
import { requireSession, verifyDatabaseInstanceAccess } from '@/lib/auth';
import { getDatabaseInstanceById } from '@/lib/db';
import { getNl2DataErrorMessage, runNl2DataExecutor } from '@/lib/nl2data/executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // 验证用户已认证
    const session = await requireSession();

    const body = await request.json();

    // 验证用户对数据库实例的访问权限
    if (body.databaseInstanceId) {
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
    }

    const result = await runNl2DataExecutor(body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to run NL2DATA executor:', error);
    return NextResponse.json(
      { error: getNl2DataErrorMessage(error) },
      { status: 500 }
    );
  }
}

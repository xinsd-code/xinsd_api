import { NextResponse } from 'next/server';
import { executeNl2DataSql, getNl2DataErrorMessage } from '@/lib/nl2data/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { databaseInstanceId?: string; sql?: string };
    if (!body.databaseInstanceId) {
      return NextResponse.json({ error: '请先选择数据源。' }, { status: 400 });
    }
    if (!body.sql?.trim()) {
      return NextResponse.json({ error: '请输入要执行的 SQL。' }, { status: 400 });
    }

    const result = await executeNl2DataSql(body.databaseInstanceId, body.sql.trim());
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to execute NL2DATA SQL:', error);
    return NextResponse.json(
      { error: getNl2DataErrorMessage(error) },
      { status: 500 }
    );
  }
}

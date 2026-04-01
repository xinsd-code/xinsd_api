import { NextResponse } from 'next/server';
import { createNl2DataSessionHistory, getNl2DataSessionHistory } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getNl2DataSessionHistory(24));
  } catch (error) {
    console.error('Failed to fetch NL2DATA session history:', error);
    return NextResponse.json({ error: '读取会话历史失败。' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      id?: string;
      timestamp?: string;
      question?: string;
      title?: string;
      trigger?: 'ai' | 'manual';
      sql?: string;
      summary?: string;
      datasource?: string;
      engine?: 'mysql' | 'pgsql';
      columns?: string[];
      rows?: Record<string, unknown>[];
      prompt?: string;
    };

    if (!body.id || !body.timestamp || !body.sql?.trim()) {
      return NextResponse.json({ error: '历史记录参数不完整。' }, { status: 400 });
    }

    const created = createNl2DataSessionHistory({
      id: body.id,
      timestamp: body.timestamp,
      question: body.question || '',
      title: body.title || body.question || '',
      trigger: body.trigger === 'manual' ? 'manual' : 'ai',
      sql: body.sql.trim(),
      summary: body.summary || '',
      datasource: body.datasource || '',
      engine: body.engine === 'pgsql' ? 'pgsql' : 'mysql',
      columns: Array.isArray(body.columns) ? body.columns : [],
      rows: Array.isArray(body.rows) ? body.rows : [],
      prompt: body.prompt || '',
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Failed to create NL2DATA session history:', error);
    return NextResponse.json({ error: '保存会话历史失败。' }, { status: 500 });
  }
}

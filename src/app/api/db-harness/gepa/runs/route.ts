import { NextResponse } from 'next/server';
import { DBHarnessGepaCreateRequest } from '@/lib/db-harness/core/types';
import { listGepaRuns, runGepaCreate } from '@/lib/db-harness/gepa/gepa-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get('limit') || '24', 10);
    return NextResponse.json({ runs: listGepaRuns(Number.isFinite(limit) ? limit : 24) });
  } catch (error) {
    console.error('Failed to list GEPA runs:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '获取 GEPA 任务失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<DBHarnessGepaCreateRequest>;
    if (!body?.workspaceId) {
      return NextResponse.json({ error: '请提供 workspaceId。' }, { status: 400 });
    }
    if (!body?.databaseId) {
      return NextResponse.json({ error: '请提供 databaseId。' }, { status: 400 });
    }

    const run = await runGepaCreate({
      workspaceId: body.workspaceId,
      databaseId: body.databaseId,
      sampleLimit: body.sampleLimit,
      promptCandidateCount: body.promptCandidateCount,
      policyCandidateCount: body.policyCandidateCount,
    });
    return NextResponse.json({ run });
  } catch (error) {
    console.error('Failed to create GEPA run:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '创建 GEPA 任务失败' }, { status: 500 });
  }
}

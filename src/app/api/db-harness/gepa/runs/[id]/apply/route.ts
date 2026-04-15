import { NextResponse } from 'next/server';
import { DBHarnessGepaApplyRequest } from '@/lib/db-harness/core/types';
import { applyGepaRun } from '@/lib/db-harness/gepa/gepa-service';
import { getDBHarnessWorkspaceById } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as Partial<DBHarnessGepaApplyRequest>;
    const run = applyGepaRun(id, {
      approvedBy: body.approvedBy,
    });
    if (!run) {
      return NextResponse.json({ error: 'GEPA 任务不存在。' }, { status: 404 });
    }
    return NextResponse.json({
      run: run.run,
      workspace: getDBHarnessWorkspaceById(run.workspaceId),
    });
  } catch (error) {
    console.error('Failed to apply GEPA run:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '应用 GEPA 任务失败' }, { status: 500 });
  }
}

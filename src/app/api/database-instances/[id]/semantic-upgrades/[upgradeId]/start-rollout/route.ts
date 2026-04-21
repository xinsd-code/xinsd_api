import { NextResponse } from 'next/server';
import { startSemanticRollout } from '@/lib/db-harness/upgrade/semantic-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string; upgradeId: string }> }) {
  try {
    const { id, upgradeId } = await context.params;
    const body = await request.json() as { workspaceIds?: string[] };
    const result = startSemanticRollout({
      databaseId: id,
      upgradeId,
      workspaceIds: Array.isArray(body.workspaceIds) ? body.workspaceIds : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to start semantic rollout:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '启动语义灰度失败' }, { status: 500 });
  }
}

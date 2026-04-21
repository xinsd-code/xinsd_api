import { NextResponse } from 'next/server';
import { rejectWorkspaceUpgrade } from '@/lib/db-harness/upgrade/workspace-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string; upgradeId: string }> }) {
  try {
    const { id, upgradeId } = await context.params;
    const body = await request.json() as { reason?: string };
    const upgrade = rejectWorkspaceUpgrade({
      workspaceId: id,
      upgradeId,
      reason: body.reason,
    });
    return NextResponse.json({ upgrade });
  } catch (error) {
    console.error('Failed to reject workspace upgrade:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '拒绝 workspace 升级失败' }, { status: 500 });
  }
}

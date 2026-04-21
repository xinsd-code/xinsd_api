import { NextResponse } from 'next/server';
import { applyWorkspaceUpgrade } from '@/lib/db-harness/upgrade/workspace-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string; upgradeId: string }> }) {
  try {
    const { id, upgradeId } = await context.params;
    const body = await request.json() as { approvedBy?: string };
    const upgrade = applyWorkspaceUpgrade({
      workspaceId: id,
      upgradeId,
      approvedBy: body.approvedBy,
    });
    return NextResponse.json({ upgrade });
  } catch (error) {
    console.error('Failed to apply workspace upgrade:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '应用 workspace 升级失败' }, { status: 500 });
  }
}

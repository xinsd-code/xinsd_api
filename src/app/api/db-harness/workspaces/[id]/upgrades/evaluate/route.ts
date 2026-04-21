import { NextResponse } from 'next/server';
import { evaluateWorkspaceUpgrade } from '@/lib/db-harness/upgrade/workspace-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as { upgradeId?: string };
    if (!body.upgradeId?.trim()) {
      return NextResponse.json({ error: '请提供 upgradeId。' }, { status: 400 });
    }
    const upgrade = evaluateWorkspaceUpgrade({
      workspaceId: id,
      upgradeId: body.upgradeId,
    });
    return NextResponse.json({ upgrade });
  } catch (error) {
    console.error('Failed to evaluate workspace upgrade:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '评估 workspace 升级失败' }, { status: 500 });
  }
}

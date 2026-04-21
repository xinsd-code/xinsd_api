import { NextResponse } from 'next/server';
import { rejectSemanticUpgrade } from '@/lib/db-harness/upgrade/semantic-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string; upgradeId: string }> }) {
  try {
    const { id, upgradeId } = await context.params;
    const body = await request.json() as { reason?: string };
    const upgrade = rejectSemanticUpgrade({
      databaseId: id,
      upgradeId,
      reason: body.reason,
    });
    return NextResponse.json({ upgrade });
  } catch (error) {
    console.error('Failed to reject semantic upgrade:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '拒绝语义升级失败' }, { status: 500 });
  }
}

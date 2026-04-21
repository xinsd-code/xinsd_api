import { NextResponse } from 'next/server';
import { evaluateSemanticUpgrade } from '@/lib/db-harness/upgrade/semantic-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as { upgradeId?: string };
    if (!body.upgradeId?.trim()) {
      return NextResponse.json({ error: '请提供 upgradeId。' }, { status: 400 });
    }
    const upgrade = evaluateSemanticUpgrade({
      databaseId: id,
      upgradeId: body.upgradeId,
    });
    return NextResponse.json({ upgrade });
  } catch (error) {
    console.error('Failed to evaluate semantic upgrades:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '评估语义升级失败' }, { status: 500 });
  }
}

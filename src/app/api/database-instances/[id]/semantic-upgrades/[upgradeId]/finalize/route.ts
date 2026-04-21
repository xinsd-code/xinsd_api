import { NextResponse } from 'next/server';
import { finalizeSemanticUpgrade } from '@/lib/db-harness/upgrade/semantic-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string; upgradeId: string }> }) {
  try {
    const { id, upgradeId } = await context.params;
    const result = await finalizeSemanticUpgrade({
      databaseId: id,
      upgradeId,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to finalize semantic upgrade:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '应用语义升级失败' }, { status: 500 });
  }
}

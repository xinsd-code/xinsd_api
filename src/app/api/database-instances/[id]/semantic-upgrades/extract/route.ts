import { NextResponse } from 'next/server';
import { extractSemanticUpgrades } from '@/lib/db-harness/upgrade/semantic-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as { sourceWorkspaceId?: string; limit?: number };
    if (!body.sourceWorkspaceId?.trim()) {
      return NextResponse.json({ error: '请提供 sourceWorkspaceId。' }, { status: 400 });
    }
    const upgrades = extractSemanticUpgrades({
      databaseId: id,
      sourceWorkspaceId: body.sourceWorkspaceId,
      limit: body.limit,
    });
    return NextResponse.json({ upgrades });
  } catch (error) {
    console.error('Failed to extract semantic upgrades:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '抽取语义升级失败' }, { status: 500 });
  }
}

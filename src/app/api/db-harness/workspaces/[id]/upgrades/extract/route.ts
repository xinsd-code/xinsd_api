import { NextResponse } from 'next/server';
import { extractWorkspaceUpgrades } from '@/lib/db-harness/upgrade/workspace-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as { limit?: number };
    const upgrades = extractWorkspaceUpgrades({
      workspaceId: id,
      limit: body.limit,
    });
    return NextResponse.json({ upgrades });
  } catch (error) {
    console.error('Failed to extract workspace upgrades:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '抽取 workspace 升级失败' }, { status: 500 });
  }
}

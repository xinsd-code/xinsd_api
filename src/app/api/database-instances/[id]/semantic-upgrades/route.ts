import { NextResponse } from 'next/server';
import {
  evaluateSemanticUpgrade,
  extractSemanticUpgrades,
  listSemanticUpgradeGovernance,
  listSemanticUpgrades,
} from '@/lib/db-harness/upgrade/semantic-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || undefined;
    const upgrades = listSemanticUpgrades(id, status as Parameters<typeof listSemanticUpgrades>[1]);
    const governance = listSemanticUpgradeGovernance(id, status as Parameters<typeof listSemanticUpgrades>[1]);
    return NextResponse.json({ upgrades, governance });
  } catch (error) {
    console.error('Failed to list semantic upgrades:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取语义升级列表失败' }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as {
      action?: 'extract' | 'evaluate';
      sourceWorkspaceId?: string;
      upgradeId?: string;
      limit?: number;
    };
    const action = body.action || 'extract';

    if (action === 'evaluate') {
      if (!body.upgradeId?.trim()) {
        return NextResponse.json({ error: '请提供 upgradeId。' }, { status: 400 });
      }
      const upgrade = evaluateSemanticUpgrade({
        databaseId: id,
        upgradeId: body.upgradeId,
      });
      return NextResponse.json({ upgrade });
    }

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
    console.error('Failed to process semantic upgrades:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '处理语义升级失败' }, { status: 500 });
  }
}

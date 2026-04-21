import { NextResponse } from 'next/server';
import {
  extractWorkspaceUpgrades,
  evaluateWorkspaceUpgrade,
  listWorkspaceUpgrades,
} from '@/lib/db-harness/upgrade/workspace-upgrade-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || undefined;
    const upgrades = listWorkspaceUpgrades(id, status as Parameters<typeof listWorkspaceUpgrades>[1]);
    return NextResponse.json({ upgrades });
  } catch (error) {
    console.error('Failed to list workspace upgrades:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取 workspace 升级列表失败' }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as {
      action?: 'extract' | 'evaluate';
      upgradeId?: string;
      limit?: number;
    };
    const action = body.action || 'extract';

    if (action === 'evaluate') {
      if (!body.upgradeId?.trim()) {
        return NextResponse.json({ error: '请提供 upgradeId。' }, { status: 400 });
      }
      const upgrade = evaluateWorkspaceUpgrade({
        workspaceId: id,
        upgradeId: body.upgradeId,
      });
      return NextResponse.json({ upgrade });
    }

    const upgrades = extractWorkspaceUpgrades({
      workspaceId: id,
      limit: body.limit,
    });
    return NextResponse.json({ upgrades });
  } catch (error) {
    console.error('Failed to process workspace upgrades:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '处理 workspace 升级失败' }, { status: 500 });
  }
}

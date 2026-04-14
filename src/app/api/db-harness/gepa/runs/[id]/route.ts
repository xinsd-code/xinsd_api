import { NextResponse } from 'next/server';
import { getGepaRun, removeGepaRun } from '@/lib/db-harness/gepa/gepa-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const run = getGepaRun(id);
    if (!run) {
      return NextResponse.json({ error: 'GEPA 任务不存在。' }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (error) {
    console.error('Failed to get GEPA run:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '获取 GEPA 任务失败' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const deleted = removeGepaRun(id);
    if (!deleted) {
      return NextResponse.json({ error: 'GEPA 任务不存在。' }, { status: 404 });
    }
    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error('Failed to delete GEPA run:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '删除 GEPA 任务失败' }, { status: 500 });
  }
}

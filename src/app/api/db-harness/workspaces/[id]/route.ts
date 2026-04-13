import { NextResponse } from 'next/server';
import { deleteDBHarnessWorkspace, updateDBHarnessWorkspace } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: '缺少工作区 ID。' }, { status: 400 });
    }

    const body = await request.json() as { name?: string; databaseId?: string; rules?: string };
    const updated = updateDBHarnessWorkspace({
      id,
      name: body.name,
      databaseId: body.databaseId,
      rules: body.rules,
    });

    if (!updated) {
      return NextResponse.json({ error: '工作区不存在。' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update DB Harness workspace:', error);
    return NextResponse.json({ error: '更新 DB Harness 工作区失败。' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: '缺少工作区 ID。' }, { status: 400 });
    }

    const deleted = deleteDBHarnessWorkspace(id);
    if (!deleted) {
      return NextResponse.json({ error: '工作区不存在。' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete DB Harness workspace:', error);
    return NextResponse.json({ error: '删除 DB Harness 工作区失败。' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { deleteDBHarnessSession, updateDBHarnessSession } from '@/lib/db';
import type { DBHarnessChatMessage, DBHarnessSelectedModelInput } from '@/lib/db-harness/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: '缺少会话 ID。' }, { status: 400 });
    }

    const body = await request.json() as {
      title?: string;
      messages?: DBHarnessChatMessage[];
      selectedDatabaseId?: string;
      selectedModel?: DBHarnessSelectedModelInput | null;
      lastMessageAt?: string;
    };

    const updated = updateDBHarnessSession({
      id,
      title: body.title,
      messages: Array.isArray(body.messages) ? body.messages : undefined,
      selectedDatabaseId: body.selectedDatabaseId,
      selectedModel: body.selectedModel,
      lastMessageAt: body.lastMessageAt,
    });

    if (!updated) {
      return NextResponse.json({ error: '会话不存在。' }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update DB Harness session:', error);
    return NextResponse.json({ error: '更新 DB Harness 会话失败。' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: '缺少会话 ID。' }, { status: 400 });
    }

    const deleted = deleteDBHarnessSession(id);
    if (!deleted) {
      return NextResponse.json({ error: '会话不存在。' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete DB Harness session:', error);
    return NextResponse.json({ error: '删除 DB Harness 会话失败。' }, { status: 500 });
  }
}

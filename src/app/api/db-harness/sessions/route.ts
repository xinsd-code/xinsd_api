import { NextResponse } from 'next/server';
import { createDBHarnessSession } from '@/lib/db';
import type { DBHarnessChatMessage, DBHarnessSelectedModelInput } from '@/lib/db-harness/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      id?: string;
      workspaceId?: string;
      title?: string;
      messages?: DBHarnessChatMessage[];
      selectedDatabaseId?: string;
      selectedModel?: DBHarnessSelectedModelInput | null;
      lastMessageAt?: string;
    };

    if (!body.workspaceId) {
      return NextResponse.json({ error: '缺少工作区 ID。' }, { status: 400 });
    }

    const session = createDBHarnessSession({
      id: body.id,
      workspaceId: body.workspaceId,
      title: body.title || '新会话',
      messages: Array.isArray(body.messages) ? body.messages : [],
      selectedDatabaseId: body.selectedDatabaseId || '',
      selectedModel: body.selectedModel || null,
      lastMessageAt: body.lastMessageAt,
    });

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    console.error('Failed to create DB Harness session:', error);
    return NextResponse.json({ error: '创建 DB Harness 会话失败。' }, { status: 500 });
  }
}

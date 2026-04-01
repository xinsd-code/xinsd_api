import { NextResponse } from 'next/server';
import { deleteNl2DataSessionHistory } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: '缺少历史记录 ID。' }, { status: 400 });
    }

    const deleted = deleteNl2DataSessionHistory(id);
    if (!deleted) {
      return NextResponse.json({ error: '会话历史不存在。' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete NL2DATA session history:', error);
    return NextResponse.json({ error: '删除会话历史失败。' }, { status: 500 });
  }
}

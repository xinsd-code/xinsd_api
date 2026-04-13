import { NextResponse } from 'next/server';
import { upsertDBHarnessKnowledgeMemory } from '@/lib/db';
import {
  DBHarnessKnowledgeFeedbackRequest,
  DBHarnessKnowledgeFeedbackResponse,
} from '@/lib/db-harness/core/types';
import { createFeedbackKnowledgeEntry } from '@/lib/db-harness/memory/knowledge-memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<DBHarnessKnowledgeFeedbackRequest>;
    if (!body?.messageId || !body.databaseInstanceId || !body.question || !body.reply) {
      return NextResponse.json({ error: '反馈缺少必要字段。' }, { status: 400 });
    }

    const feedbackType = body.feedbackType === 'corrective' ? 'corrective' : body.feedbackType === 'positive' ? 'positive' : null;
    if (!feedbackType) {
      return NextResponse.json({ error: '反馈类型不正确。' }, { status: 400 });
    }

    const entry = createFeedbackKnowledgeEntry({
      question: body.question,
      feedbackType,
      note: body.note,
      artifact: body.artifacts,
    });

    const knowledgeEntry = upsertDBHarnessKnowledgeMemory({
      key: entry.key,
      workspaceId: body.workspaceId,
      databaseId: body.databaseInstanceId,
      sessionId: body.sessionId,
      messageId: body.messageId,
      source: 'feedback',
      feedbackType,
      summary: entry.summary,
      tags: entry.tags,
      payload: {
        question: body.question,
        reply: body.reply,
        note: body.note || '',
        artifact: body.artifacts || null,
      },
    });

    const response: DBHarnessKnowledgeFeedbackResponse = {
      feedback: {
        status: feedbackType,
        note: body.note?.trim() || undefined,
        learnedAt: new Date().toISOString(),
        summary: knowledgeEntry.summary,
      },
      knowledgeEntry,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Failed to save DB Harness feedback:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '保存反馈失败' }, { status: 500 });
  }
}

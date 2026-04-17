import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { upsertDBHarnessKnowledgeMemory, upsertDBHarnessPromptTemplate } from '@/lib/db';
import {
  DBHarnessKnowledgeFeedbackRequest,
  DBHarnessKnowledgeFeedbackResponse,
} from '@/lib/db-harness/core/types';
import { createFeedbackKnowledgeEntry } from '@/lib/db-harness/memory/knowledge-memory';
import { buildPromptTemplateRecord, shouldPersistPromptTemplate } from '@/lib/db-harness/memory/prompt-template';

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
        questionHash: createHash('sha256').update(body.question.trim()).digest('hex'),
        confidence: Number(body.confidence || 0),
        fromCache: body.fromCache === true,
        artifact: body.artifacts || null,
        correctionRule: entry.correctionRule || null,
      },
    });

    if (shouldPersistPromptTemplate({
      feedbackType,
      confidence: body.confidence,
      fromCache: body.fromCache,
    })) {
      const promptTemplate = buildPromptTemplateRecord({
        knowledgeEntry,
        databaseId: body.databaseInstanceId,
        workspaceId: body.workspaceId,
        confidence: body.confidence,
        fromCache: body.fromCache,
        source: 'feedback',
      });
      upsertDBHarnessPromptTemplate({
        templateKey: promptTemplate.templateKey,
        workspaceId: promptTemplate.workspaceId,
        databaseId: promptTemplate.databaseId,
        source: promptTemplate.source,
        title: promptTemplate.title,
        description: promptTemplate.description,
        promptPatch: promptTemplate.promptPatch,
        compressionLevel: promptTemplate.compressionLevel,
        nerCandidateLimit: promptTemplate.nerCandidateLimit,
        questionHash: createHash('sha256').update(body.question.trim()).digest('hex'),
        queryFingerprint: body.artifacts?.sql
          ? createHash('sha256').update(`${body.databaseInstanceId}|${body.artifacts.sql}`).digest('hex')
          : undefined,
        confidence: promptTemplate.confidence,
        labels: promptTemplate.labels,
        usageCount: 0,
      });
    }

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

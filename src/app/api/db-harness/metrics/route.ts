import { NextResponse } from 'next/server';
import { requireSession, verifyDatabaseInstanceAccess } from '@/lib/auth';
import { getDatabaseInstanceById, listDBHarnessQueryMetrics, upsertDBHarnessQueryMetric } from '@/lib/db';
import { DBHarnessQueryMetricRecord } from '@/lib/db-harness/core/types';
import { maybeTriggerOnlineGepaEvaluation } from '@/lib/db-harness/gepa/gepa-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function verifyAccess(databaseId?: string) {
  if (!databaseId) return;
  const instance = getDatabaseInstanceById(databaseId);
  if (!instance) return;
  const hasAccess = await verifyDatabaseInstanceAccess(
    instance.workspaceId || 'default-workspace',
    instance.ownerId
  );
  if (!hasAccess) {
    throw new Error('您没有权限访问该数据源');
  }
}

export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);
    const databaseId = url.searchParams.get('databaseId') || '';
    const workspaceId = url.searchParams.get('workspaceId') || '';
    const limit = Number.parseInt(url.searchParams.get('limit') || '24', 10);
    await verifyAccess(databaseId || undefined);
    return NextResponse.json({
      metrics: listDBHarnessQueryMetrics({
        databaseId,
        workspaceId,
        limit: Number.isFinite(limit) ? limit : 24,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取 DB Harness 指标失败';
    const status = message.includes('权限') ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = await request.json() as Partial<DBHarnessQueryMetricRecord>;
    if (!body?.turnId || !body.databaseId || !body.question || !body.queryFingerprint) {
      return NextResponse.json({ error: '指标记录缺少必要字段。' }, { status: 400 });
    }

    await verifyAccess(body.databaseId);
    const metric = upsertDBHarnessQueryMetric({
      id: body.id,
      turnId: body.turnId,
      workspaceId: body.workspaceId,
      databaseId: body.databaseId,
      engine: body.engine || 'mysql',
      question: body.question,
      questionHash: body.questionHash || '',
      sql: body.sql || '',
      queryFingerprint: body.queryFingerprint,
      outcome: body.outcome || 'error',
      confidence: Number(body.confidence || 0),
      fromCache: body.fromCache === true,
      rowCount: Number(body.rowCount || 0),
      agentTelemetry: body.agentTelemetry || {},
      labels: body.labels || [],
      errorMessage: body.errorMessage,
      createdAt: body.createdAt,
      updatedAt: body.updatedAt,
    });
    try {
      await maybeTriggerOnlineGepaEvaluation({
        workspaceId: metric.workspaceId,
        databaseId: metric.databaseId,
        turnId: metric.turnId,
      });
    } catch (error) {
      console.error('Failed to trigger online GEPA from metrics API:', error);
    }
    return NextResponse.json({ metric });
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存 DB Harness 指标失败';
    const status = message.includes('权限') ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

import { NextResponse } from 'next/server';
import { getDatabaseInstanceById, updateDatabaseInstanceSemanticModel } from '@/lib/db';
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { deriveSemanticSnapshot } from '@/lib/db-harness/tools/catalog-tools';
import type { DatabaseSemanticModel } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function generateSemanticModel(instanceId: string): Promise<DatabaseSemanticModel> {
  const instance = getDatabaseInstanceById(instanceId);
  if (!instance) {
    throw new Error('数据库实例不存在');
  }

  const schema = await getDatabaseSchema(instance);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: instance.metricMappings,
    semanticModel: instance.semanticModel,
  });

  return {
    ...deriveSemanticSnapshot(schema, metricMappings),
    source: 'generated',
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const instance = getDatabaseInstanceById(id);
    if (!instance) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    const semanticModel = sanitizeDatabaseSemanticModel(instance.semanticModel) || await generateSemanticModel(id);
    return NextResponse.json(semanticModel);
  } catch (error) {
    console.error('Failed to get semantic model:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '读取语义模型失败' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const persist = body && typeof body === 'object' && 'persist' in body ? body.persist === true : false;
    const semanticModel = await generateSemanticModel(id);

    if (persist) {
      const updated = updateDatabaseInstanceSemanticModel(id, semanticModel);
      if (!updated) {
        return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
      }
      return NextResponse.json(updated.semanticModel || semanticModel);
    }

    return NextResponse.json(semanticModel);
  } catch (error) {
    console.error('Failed to generate semantic model:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '生成语义模型失败' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const semanticModel = sanitizeDatabaseSemanticModel(body?.semanticModel);
    if (!semanticModel) {
      return NextResponse.json({ error: '语义模型格式不正确。' }, { status: 400 });
    }

    const updated = updateDatabaseInstanceSemanticModel(id, {
      ...semanticModel,
      source: 'manual',
      updatedAt: new Date().toISOString(),
    });
    if (!updated) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    return NextResponse.json(updated.semanticModel);
  } catch (error) {
    console.error('Failed to update semantic model:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '保存语义模型失败' }, { status: 500 });
  }
}

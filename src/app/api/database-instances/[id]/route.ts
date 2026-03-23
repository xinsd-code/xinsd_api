import { NextResponse } from 'next/server';
import {
  deleteDatabaseInstance,
  getDatabaseInstanceById,
  updateDatabaseInstance,
} from '@/lib/db';
import {
  sanitizeDatabaseInstanceInput,
  validateDatabaseInstanceInput,
} from '@/lib/database-instances';
import {
  verifyDatabaseInstanceConnection,
} from '@/lib/database-instances-server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const instance = getDatabaseInstanceById(id);
    if (!instance) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }
    return NextResponse.json(instance);
  } catch (error) {
    console.error('Failed to get database instance:', error);
    return NextResponse.json({ error: '获取数据库实例失败' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = getDatabaseInstanceById(id);
    if (!existing) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }

    const body = await request.json();
    const data = sanitizeDatabaseInstanceInput({
      ...existing,
      ...body,
    });
    const validationError = validateDatabaseInstanceInput(data);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const availability = await verifyDatabaseInstanceConnection(data);
    if (!availability.ok) {
      return NextResponse.json({ error: availability.message }, { status: 400 });
    }

    const updated = updateDatabaseInstance(id, data);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update database instance:', error);
    return NextResponse.json({ error: '更新数据库实例失败' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const success = deleteDatabaseInstance(id);
    if (!success) {
      return NextResponse.json({ error: '数据库实例不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete database instance:', error);
    return NextResponse.json({ error: '删除数据库实例失败' }, { status: 500 });
  }
}

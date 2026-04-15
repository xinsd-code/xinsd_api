import { NextResponse } from 'next/server';
import { createDatabaseInstance, getAllDatabaseInstancesSummary } from '@/lib/db';
import {
  sanitizeDatabaseInstanceInput,
  validateDatabaseInstanceInput,
} from '@/lib/database-instances';
import {
  verifyDatabaseInstanceConnection,
} from '@/lib/database-instances-server';
import { requireSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Verify user is authenticated
    const session = await requireSession();

    // Get all instances and filter by workspace
    const allInstances = getAllDatabaseInstancesSummary();
    const userInstances = allInstances.filter(
      instance => instance.workspaceId === session.workspaceId
    );

    return NextResponse.json(userInstances);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to get database instances:', error);
    return NextResponse.json({ error: '获取数据库实例失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // Verify user is authenticated
    const session = await requireSession();

    const body = await request.json();
    const data = sanitizeDatabaseInstanceInput(body);
    const validationError = validateDatabaseInstanceInput(data);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const availability = await verifyDatabaseInstanceConnection(data);
    if (!availability.ok) {
      return NextResponse.json({ error: availability.message }, { status: 400 });
    }

    // Attach ownership information
    const dataWithOwnership = {
      ...data,
      ownerId: session.userId,
      workspaceId: session.workspaceId,
    };

    const created = createDatabaseInstance(dataWithOwnership);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to create database instance:', error);
    return NextResponse.json({ error: '创建数据库实例失败' }, { status: 500 });
  }
}

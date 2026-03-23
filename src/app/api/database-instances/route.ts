import { NextResponse } from 'next/server';
import { createDatabaseInstance, getAllDatabaseInstances } from '@/lib/db';
import {
  sanitizeDatabaseInstanceInput,
  validateDatabaseInstanceInput,
} from '@/lib/database-instances';
import {
  verifyDatabaseInstanceConnection,
} from '@/lib/database-instances-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getAllDatabaseInstances());
  } catch (error) {
    console.error('Failed to get database instances:', error);
    return NextResponse.json({ error: '获取数据库实例失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
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

    const created = createDatabaseInstance(data);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Failed to create database instance:', error);
    return NextResponse.json({ error: '创建数据库实例失败' }, { status: 500 });
  }
}

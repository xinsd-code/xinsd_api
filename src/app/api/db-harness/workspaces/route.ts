import { NextResponse } from 'next/server';
import { createDBHarnessWorkspace, getDBHarnessWorkspaces } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getDBHarnessWorkspaces());
  } catch (error) {
    console.error('Failed to fetch DB Harness workspaces:', error);
    return NextResponse.json({ error: '读取 DB Harness 工作区失败。' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { id?: string; name?: string; databaseId?: string; rules?: string };
    const workspace = createDBHarnessWorkspace({
      id: body.id,
      name: body.name?.trim() || '新建 Workspace',
      databaseId: body.databaseId?.trim() || '',
      rules: body.rules?.trim() || '',
    });
    return NextResponse.json(workspace, { status: 201 });
  } catch (error) {
    console.error('Failed to create DB Harness workspace:', error);
    return NextResponse.json({ error: '创建 DB Harness 工作区失败。' }, { status: 500 });
  }
}

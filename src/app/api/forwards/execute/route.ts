import { NextResponse } from 'next/server';
import { ApiForwardConfig } from '@/lib/types';
import { executeApiForwardRuntime } from '@/lib/api-forward-runtime';
import { requireSession } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const { forwardConfig, runParams } = body as { forwardConfig: ApiForwardConfig, runParams: Record<string, string> };
    const execution = await executeApiForwardRuntime(request.url, forwardConfig, runParams);
    return NextResponse.json(execution);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : '执行转发失败' }, { status: 400 });
  }
}

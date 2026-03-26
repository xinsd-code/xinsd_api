import { NextResponse } from 'next/server';
import { ApiForwardConfig } from '@/lib/types';
import { executeApiForwardRuntime } from '@/lib/api-forward-runtime';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { forwardConfig, runParams } = body as { forwardConfig: ApiForwardConfig, runParams: Record<string, string> };
    const execution = await executeApiForwardRuntime(request.url, forwardConfig, runParams);
    return NextResponse.json({
      _meta: {
        ...execution.meta,
      },
      status: execution.status,
      headers: execution.headers,
      data: execution.data,
    });

  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Execution failed' },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { requireSession, verifyDatabaseInstanceAccess } from '@/lib/auth';
import { getDatabaseInstanceById } from '@/lib/db';
import { getDBHarnessErrorMessage, runDBHarnessChatTurn } from '@/lib/db-harness';
import type { DBHarnessChatTurnRequest, DBHarnessProgressEvent, DBHarnessTurnResponse } from '@/lib/db-harness/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildSseFrame(event: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const payload = JSON.stringify(data);
  return encoder.encode(`event: ${event}\ndata: ${payload}\n\n`);
}

function isStreamRequested(body: Record<string, unknown>, request: Request): boolean {
  if (body.stream === true) return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/event-stream');
}

async function authorizeDatabase(databaseInstanceId?: string) {
  if (!databaseInstanceId) return;
  const instance = getDatabaseInstanceById(databaseInstanceId);
  if (!instance) return;
  const hasAccess = await verifyDatabaseInstanceAccess(
    instance.workspaceId || 'default-workspace',
    instance.ownerId
  );
  if (!hasAccess) {
    throw new Error('您没有权限访问此数据源');
  }
}

async function runStreamedChatTurn(body: Record<string, unknown>) {
  const progressQueue: DBHarnessProgressEvent[] = [];
  const progressStream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = progressStream.writable.getWriter();
  let progressWriteChain = Promise.resolve();

  const writeEvent = async (event: string, data: unknown) => {
    await writer.write(buildSseFrame(event, data));
  };

  const response = new Response(progressStream.readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });

  void (async () => {
    try {
      const result = await runDBHarnessChatTurn(body as unknown as DBHarnessChatTurnRequest, {
        onProgress: (event) => {
          progressQueue.push(event);
          progressWriteChain = progressWriteChain.then(() => writeEvent('progress', event));
        },
      }).then((turn) => ({
        ...turn,
        progress: progressQueue.length > 0 ? progressQueue : turn.progress || [],
      }) satisfies DBHarnessTurnResponse);

      await progressWriteChain;
      await writeEvent('final', result);
    } catch (error) {
      await progressWriteChain;
      await writeEvent('error', {
        error: error instanceof Error ? error.message : 'DB Harness 流式执行失败',
      });
    } finally {
      await writer.close();
    }
  })();

  return response;
}

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = await request.json() as Record<string, unknown>;

    await authorizeDatabase(typeof body.databaseInstanceId === 'string' ? body.databaseInstanceId : undefined);

    if (isStreamRequested(body, request)) {
      return await runStreamedChatTurn(body);
    }

    const result = await runDBHarnessChatTurn(body as unknown as DBHarnessChatTurnRequest);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to run DB-Multi-Agent:', error);
    return NextResponse.json(
      { error: getDBHarnessErrorMessage(error) },
      { status: 500 }
    );
  }
}

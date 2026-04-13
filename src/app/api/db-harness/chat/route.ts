import { NextResponse } from 'next/server';
import { getDBHarnessErrorMessage, runDBHarnessChatTurn } from '@/lib/db-harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await runDBHarnessChatTurn(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to run DB-Multi-Agent:', error);
    return NextResponse.json(
      { error: getDBHarnessErrorMessage(error) },
      { status: 500 }
    );
  }
}

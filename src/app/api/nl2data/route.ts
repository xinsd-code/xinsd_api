import { NextResponse } from 'next/server';
import { getNl2DataErrorMessage, runNl2DataHarness } from '@/lib/nl2data/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await runNl2DataHarness(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to run NL2DATA harness:', error);
    return NextResponse.json(
      { error: getNl2DataErrorMessage(error) },
      { status: 500 }
    );
  }
}

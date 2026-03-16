import { NextResponse } from 'next/server';
import { getGroupVariables, saveGroupVariables } from '@/lib/db';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> | { name: string } }
) {
  try {
    const resolvedParams = await params;
    const name = decodeURIComponent(resolvedParams.name);
    const variables = getGroupVariables(name);
    return NextResponse.json(variables);
  } catch (error) {
    console.error('Failed to get group variables:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> | { name: string } }
) {
  try {
    const resolvedParams = await params;
    const name = decodeURIComponent(resolvedParams.name);
    const body = await request.json();
    
    // Body should be an array of KeyValuePair
    if (!Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid format: expected array' }, { status: 400 });
    }

    saveGroupVariables(name, body);
    return NextResponse.json({ success: true, variables: getGroupVariables(name) });
  } catch (error) {
    console.error('Failed to save group variables:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

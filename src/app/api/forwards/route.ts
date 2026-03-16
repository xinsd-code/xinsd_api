import { NextResponse } from 'next/server';
import { getAllApiForwards, createApiForward } from '@/lib/db';
import { CreateApiForwardConfig } from '@/lib/types';

export async function GET() {
  try {
    const forwards = getAllApiForwards();
    return NextResponse.json(forwards);
  } catch (error) {
    console.error('Failed to get API forwards:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const data: CreateApiForwardConfig = await request.json();
    
    // Validate required fields
    if (!data.name || !data.path || !data.method || !data.targetType || !data.targetId) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const newForward = createApiForward(data);
    return NextResponse.json(newForward, { status: 201 });
  } catch (error) {
    console.error('Failed to create API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

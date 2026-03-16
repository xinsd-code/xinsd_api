import { NextResponse } from 'next/server';
import { getApiForwardById, updateApiForward, deleteApiForward } from '@/lib/db';
import { UpdateApiForwardConfig } from '@/lib/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await params;
    const forward = getApiForwardById(resolvedParams.id);
    if (!forward) {
      return NextResponse.json({ error: 'API Forward not found' }, { status: 404 });
    }
    return NextResponse.json(forward);
  } catch (error) {
    console.error('Failed to get API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await params;
    const data: UpdateApiForwardConfig = await request.json();
    
    const forward = updateApiForward(resolvedParams.id, data);
    
    if (!forward) {
      return NextResponse.json({ error: 'API Forward not found' }, { status: 404 });
    }
    
    return NextResponse.json(forward);
  } catch (error) {
    console.error('Failed to update API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const resolvedParams = await params;
    const success = deleteApiForward(resolvedParams.id);
    if (!success) {
      return NextResponse.json({ error: 'API Forward not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete API forward:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

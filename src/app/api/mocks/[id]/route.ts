import { NextResponse } from 'next/server';
import { getMockById, updateMock, deleteMock } from '@/lib/db';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const mock = getMockById(id);
    if (!mock) {
      return NextResponse.json({ error: 'Mock not found' }, { status: 404 });
    }
    return NextResponse.json(mock);
  } catch (error) {
    console.error('Failed to get mock:', error);
    return NextResponse.json({ error: 'Failed to get mock' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const mock = updateMock(id, {
      name: body.name,
      path: body.path ? (body.path.startsWith('/') ? body.path : '/' + body.path) : undefined,
      method: body.method?.toUpperCase(),
      description: body.description,
      enabled: body.enabled,
      requestHeaders: body.requestHeaders,
      requestParams: body.requestParams,
      responseStatus: body.responseStatus,
      responseHeaders: body.responseHeaders,
      responseBody: body.responseBody,
      responseDelay: body.responseDelay,
      isStream: body.isStream,
      streamConfig: body.streamConfig,
      apiGroup: body.apiGroup,
    });

    if (!mock) {
      return NextResponse.json({ error: 'Mock not found' }, { status: 404 });
    }
    return NextResponse.json(mock);
  } catch (error) {
    console.error('Failed to update mock:', error);
    return NextResponse.json({ error: 'Failed to update mock' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const success = deleteMock(id);
    if (!success) {
      return NextResponse.json({ error: 'Mock not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete mock:', error);
    return NextResponse.json({ error: 'Failed to delete mock' }, { status: 500 });
  }
}

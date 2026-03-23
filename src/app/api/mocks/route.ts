import { NextResponse } from 'next/server';
import { getAllMocksSummary, createMock, toggleMock } from '@/lib/db';
import { CreateMockAPI } from '@/lib/types';

export async function GET() {
  try {
    const mocks = getAllMocksSummary();
    return NextResponse.json(mocks);
  } catch (error) {
    console.error('Failed to get mocks:', error);
    return NextResponse.json({ error: 'Failed to get mocks' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Check for toggle action
    if (body.action === 'toggle' && body.id) {
      const mock = toggleMock(body.id);
      if (!mock) {
        return NextResponse.json({ error: 'Mock not found' }, { status: 404 });
      }
      return NextResponse.json(mock);
    }

    // Validate required fields
    if (!body.name || !body.path || !body.method) {
      return NextResponse.json(
        { error: 'name, path, and method are required' },
        { status: 400 }
      );
    }

    const data: CreateMockAPI = {
      name: body.name,
      path: body.path.startsWith('/') ? body.path : '/' + body.path,
      method: body.method.toUpperCase(),
      description: body.description || '',
      enabled: body.enabled !== false,
      requestHeaders: body.requestHeaders || [],
      requestParams: body.requestParams || [],
      responseStatus: body.responseStatus || 200,
      responseHeaders: body.responseHeaders || [],
      responseBody: body.responseBody || '{}',
      responseDelay: body.responseDelay || 0,
      isStream: body.isStream || false,
      streamConfig: body.streamConfig || { chunkDelay: 100, chunks: [] },
      apiGroup: body.apiGroup || '未分组',
    };

    const mock = createMock(data);
    return NextResponse.json(mock, { status: 201 });
  } catch (error) {
    console.error('Failed to create mock:', error);
    return NextResponse.json({ error: 'Failed to create mock' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { getAllApiClientsSummary, createApiClient } from '@/lib/db';
import { CreateApiClientConfig } from '@/lib/types';

export async function GET() {
  try {
    const clients = getAllApiClientsSummary();
    return NextResponse.json(clients);
  } catch (error) {
    console.error('Failed to get api clients:', error);
    return NextResponse.json({ error: 'Failed to get api clients' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.name || !body.url || !body.method) {
      return NextResponse.json(
        { error: 'name, url, and method are required' },
        { status: 400 }
      );
    }

    const data: CreateApiClientConfig = {
      name: body.name,
      url: body.url,
      method: body.method.toUpperCase(),
      description: body.description || '',
      requestHeaders: body.requestHeaders || [],
      requestParams: body.requestParams || [],
      requestBody: body.requestBody || '{}',
      apiGroup: body.apiGroup || '未分组',
    };

    const client = createApiClient(data);
    return NextResponse.json(client, { status: 201 });
  } catch (error) {
    console.error('Failed to create api client:', error);
    return NextResponse.json({ error: 'Failed to create api client' }, { status: 500 });
  }
}

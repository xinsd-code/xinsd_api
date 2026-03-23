import { NextResponse } from 'next/server';
import { getApiClientById, updateApiClient, deleteApiClient } from '@/lib/db';
import { UpdateApiClientConfig } from '@/lib/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const client = getApiClientById(id);
    if (!client) {
      return NextResponse.json({ error: 'API Client not found' }, { status: 404 });
    }
    return NextResponse.json(client);
  } catch (error) {
    console.error('Failed to get API Client:', error);
    return NextResponse.json({ error: 'Failed to get API Client' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const data: UpdateApiClientConfig = {};

    if (body.name !== undefined) data.name = body.name;
    if (body.url !== undefined) data.url = body.url;
    if (body.method !== undefined) data.method = body.method;
    if (body.description !== undefined) data.description = body.description;
    if (body.requestHeaders !== undefined) data.requestHeaders = body.requestHeaders;
    if (body.requestParams !== undefined) data.requestParams = body.requestParams;
    if (body.requestBody !== undefined) data.requestBody = body.requestBody;
    if (body.apiGroup !== undefined) data.apiGroup = body.apiGroup;

    const mock = updateApiClient(id, data);
    
    if (!mock) {
      return NextResponse.json({ error: 'API Client not found' }, { status: 404 });
    }

    return NextResponse.json(mock);
  } catch (error) {
    console.error('Failed to update API Client:', error);
    return NextResponse.json({ error: 'Failed to update API Client' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const success = deleteApiClient(id);
    
    if (!success) {
      return NextResponse.json({ error: 'API Client not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete API Client:', error);
    return NextResponse.json({ error: 'Failed to delete API Client' }, { status: 500 });
  }
}

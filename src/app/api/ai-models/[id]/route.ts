import { NextResponse } from 'next/server';
import { deleteAIModelProfile, getAIModelProfileById, updateAIModelProfile } from '@/lib/db';
import {
  sanitizeAIModelProfileInput,
  validateAIModelProfileInput,
} from '@/lib/ai-models';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const profile = getAIModelProfileById(id);
    if (!profile) {
      return NextResponse.json({ error: '模型配置不存在' }, { status: 404 });
    }
    return NextResponse.json(profile);
  } catch (error) {
    console.error('Failed to get AI model profile:', error);
    return NextResponse.json({ error: '获取模型配置失败' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = getAIModelProfileById(id);
    if (!existing) {
      return NextResponse.json({ error: '模型配置不存在' }, { status: 404 });
    }

    const body = await request.json();
    const data = sanitizeAIModelProfileInput({
      ...existing,
      ...body,
      modelIds: body.modelIds ?? existing.modelIds,
      defaultModelId: body.defaultModelId ?? existing.defaultModelId,
      authType: body.authType ?? existing.authType,
      authToken: body.authToken ?? existing.authToken,
      authHeaderName: body.authHeaderName ?? existing.authHeaderName,
    });
    const validationError = validateAIModelProfileInput(data);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const updated = updateAIModelProfile(id, body);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update AI model profile:', error);
    return NextResponse.json({ error: '更新模型配置失败' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const success = deleteAIModelProfile(id);
    if (!success) {
      return NextResponse.json({ error: '模型配置不存在' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete AI model profile:', error);
    return NextResponse.json({ error: '删除模型配置失败' }, { status: 500 });
  }
}

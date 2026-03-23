import { NextResponse } from 'next/server';
import { createAIModelProfile, getAllAIModelProfilesSummary } from '@/lib/db';
import {
  sanitizeAIModelProfileInput,
  validateAIModelProfileInput,
} from '@/lib/ai-models';
import { CreateAIModelProfile } from '@/lib/types';

export async function GET() {
  try {
    return NextResponse.json(getAllAIModelProfilesSummary());
  } catch (error) {
    console.error('Failed to get AI model profiles:', error);
    return NextResponse.json({ error: '获取模型配置失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = sanitizeAIModelProfileInput(body);
    const validationError = validateAIModelProfileInput(data as CreateAIModelProfile);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const created = createAIModelProfile(data);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Failed to create AI model profile:', error);
    return NextResponse.json({ error: '创建模型配置失败' }, { status: 500 });
  }
}

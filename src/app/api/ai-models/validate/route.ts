import { NextResponse } from 'next/server';
import {
  getAIModelValidationSignature,
  sanitizeAIModelProfileInput,
  validateAIModelProfileInput,
  verifyAIModelAvailability,
} from '@/lib/ai-models';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = sanitizeAIModelProfileInput(body);
    const validationError = validateAIModelProfileInput(data);
    if (validationError) {
      return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
    }

    const result = await verifyAIModelAvailability(data);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.message, signature: getAIModelValidationSignature(data) },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: result.message,
      signature: getAIModelValidationSignature(data),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '模型连接测试失败' },
      { status: 500 }
    );
  }
}

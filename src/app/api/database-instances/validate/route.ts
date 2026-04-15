import { NextResponse } from 'next/server';
import {
  getDatabaseInstanceValidationSignature,
  sanitizeDatabaseInstanceInput,
  validateDatabaseInstanceInput,
} from '@/lib/database-instances';
import {
  verifyDatabaseInstanceConnection,
} from '@/lib/database-instances-server';
import { requireSession } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const data = sanitizeDatabaseInstanceInput(body);
    const validationError = validateDatabaseInstanceInput(data);
    if (validationError) {
      return NextResponse.json({
        error: validationError,
        signature: getDatabaseInstanceValidationSignature(data),
      }, { status: 400 });
    }

    const result = await verifyDatabaseInstanceConnection(data);
    if (!result.ok) {
      return NextResponse.json({
        error: result.message,
        signature: getDatabaseInstanceValidationSignature(data),
      }, { status: 400 });
    }

    return NextResponse.json({
      message: result.message,
      signature: getDatabaseInstanceValidationSignature(data),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthorized')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Failed to validate database instance:', error);
    return NextResponse.json({ error: '数据库连接验证失败' }, { status: 500 });
  }
}

/**
 * 初始化用户会话
 * 客户端应在应用启动时调用此路由
 */

import { NextResponse } from 'next/server';
import { getSession, createSession } from '@/lib/auth';

export async function GET() {
  try {
    // 检查是否已有有效会话
    const existingSession = await getSession();

    if (existingSession) {
      return NextResponse.json({
        sessionInitialized: true,
        userId: existingSession.userId,
        workspaceId: existingSession.workspaceId,
      });
    }

    // 创建新会话
    await createSession();

    return NextResponse.json({
      sessionInitialized: true,
      message: 'Session created successfully',
    });
  } catch (error) {
    console.error('Failed to initialize session:', error);
    return NextResponse.json(
      { error: '会话初始化失败' },
      { status: 500 }
    );
  }
}

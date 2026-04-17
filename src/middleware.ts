/**
 * Next.js 中间件：保护 API 路由
 * 对受保护路由自动初始化 session cookie（lazy 模式），避免首次加载 401
 */

import { NextResponse, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';

const SESSION_COOKIE_NAME = 'xinsd-api-session';
const SESSION_TIMEOUT_SECONDS = 24 * 60 * 60; // 24 小时

// 需要认证的 API 路由前缀
const PROTECTED_ROUTES = [
  '/api/database-instances',
  '/api/db-harness',
  '/api/nl2data',
  '/api/forwards',
  '/api/db-apis',
];

// 不需要认证的公共路由
const PUBLIC_ROUTES = [
  '/api/auth',
  '/api/health',
];

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // 检查是否是需要认证的路由
  const isProtectedRoute = PROTECTED_ROUTES.some(route =>
    pathname.startsWith(route)
  );

  // 检查是否是公共路由
  const isPublicRoute = PUBLIC_ROUTES.some(route =>
    pathname.startsWith(route)
  );

  // 如果是公共路由或非 API 路由，直接通过
  if (isPublicRoute || !pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // 对受保护路由：如果缺少 session cookie，自动创建一个并设置到响应中
  // 这样 auth.ts 的 getSession() 会在内存中找到或创建对应的 session
  if (isProtectedRoute) {
    const sessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value;

    if (!sessionId) {
      // 生成新的 session ID，通过 header 传递给下游 route handler
      // route handler 中的 createSession / getOrCreateSession 会据此初始化会话
      const newSessionId = nanoid();
      const response = NextResponse.next({
        headers: {
          'x-init-session-id': newSessionId,
        },
      });

      response.cookies.set(SESSION_COOKIE_NAME, newSessionId, {
        maxAge: SESSION_TIMEOUT_SECONDS,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });

      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};

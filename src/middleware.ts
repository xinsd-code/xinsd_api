/**
 * Next.js 中间件：保护 API 路由
 * 检查所有 /api/database-instances 路由的认证
 */

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';

const SESSION_COOKIE_NAME = 'xinsd-api-session';

// 需要认证的 API 路由前缀
const PROTECTED_ROUTES = [
  '/api/database-instances',
  '/api/db-harness/gepa',
  '/api/db-harness/workspaces',
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

  // 检查受保护路由的认证
  if (isProtectedRoute) {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (!sessionId) {
      return NextResponse.json(
        {
          error: 'Unauthorized - No valid session. Please initialize session first.',
          code: 'NO_SESSION',
        },
        { status: 401 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};

/**
 * 认证和授权工具库
 * 处理用户会话、权限检查和工作区隔离
 */

import { cookies } from 'next/headers';
import { nanoid } from 'nanoid';

// 会话数据结构
export interface Session {
  userId: string;
  workspaceId: string;
  createdAt: number;
}

const SESSION_COOKIE_NAME = 'xinsd-api-session';
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 小时

// 内存会话存储（生产环境应使用数据库或 Redis）
const sessions = new Map<string, Session>();

/**
 * 创建新会话
 * 默认使用 default-user/default-workspace 以兼容单用户模式和历史数据
 */
export async function createSession(
  userId: string = 'default-user',
  workspaceId: string = 'default-workspace'
): Promise<string> {
  const sessionId = nanoid();
  const session: Session = {
    userId,
    workspaceId,
    createdAt: Date.now(),
  };

  sessions.set(sessionId, session);

  // 设置会话 cookie
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    maxAge: SESSION_TIMEOUT / 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  });

  return sessionId;
}

/**
 * 获取当前会话
 * 如果 cookie 存在但内存中无对应 session（如中间件刚创建的 lazy session），
 * 则自动在内存中初始化该 session，确保首次请求不会 401。
 */
export async function getSession(request?: Request): Promise<Session | null> {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (!sessionId) {
      return null;
    }

    let session = sessions.get(sessionId);

    // 中间件可能已设置 cookie 但内存中尚无 session，自动创建
    // 使用固定默认值以兼容单用户模式和历史数据（owner_id='default-user' 的记录）
    if (!session) {
      session = {
        userId: 'default-user',
        workspaceId: 'default-workspace',
        createdAt: Date.now(),
      };
      sessions.set(sessionId, session);
    }

    // 检查会话是否过期
    if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
      return null;
    }

    return session;
  } catch (error) {
    console.error('Failed to get session:', error);
    return null;
  }
}

/**
 * 验证用户对数据库实例的访问权限
 */
export async function verifyDatabaseInstanceAccess(
  instanceWorkspaceId: string,
  instanceOwnerId?: string
): Promise<boolean> {
  const session = await getSession();

  if (!session) {
    return false;
  }

  // 检查工作区匹配
  if (instanceWorkspaceId && instanceWorkspaceId !== session.workspaceId) {
    return false;
  }

  // 如果指定了所有者，检查所有者匹配
  if (instanceOwnerId && instanceOwnerId !== session.userId) {
    return false;
  }

  return true;
}

/**
 * 销毁会话
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (sessionId) {
    sessions.delete(sessionId);
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * 确保用户已认证
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();

  if (!session) {
    throw new Error('Unauthorized - No valid session');
  }

  return session;
}

/**
 * 通用资源所有权验证
 * 用于 db-apis、forwards、workspaces 等资源级权限检查
 * default-user/default-workspace 视为公共资源，所有人可访问
 */
export async function verifyResourceOwnership(
  resourceOwnerId?: string,
  resourceWorkspaceId?: string
): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;

  if (resourceOwnerId && resourceOwnerId !== 'default-user' && resourceOwnerId !== session.userId) {
    return false;
  }
  if (resourceWorkspaceId && resourceWorkspaceId !== 'default-workspace' && resourceWorkspaceId !== session.workspaceId) {
    return false;
  }
  return true;
}

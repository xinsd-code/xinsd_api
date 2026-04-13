function extractConnectionErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }

  if (error instanceof AggregateError) {
    for (const item of error.errors) {
      const nestedCode = extractConnectionErrorCode(item);
      if (nestedCode) return nestedCode;
    }
  }

  return null;
}

export function getDBHarnessErrorMessage(error: unknown): string {
  const connectionCode = extractConnectionErrorCode(error);
  if (connectionCode === 'ECONNREFUSED') {
    return '数据库连接失败，请确认当前数据源服务已启动，并检查连接地址、端口、用户名与密码是否可用。';
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'DB-Multi-Agent 执行失败';
}

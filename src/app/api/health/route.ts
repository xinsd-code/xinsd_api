import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

function resolveDbPath(): string {
  const explicitPath = process.env.SQLITE_DB_PATH?.trim();
  if (explicitPath) {
    return path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(process.cwd(), explicitPath);
  }

  const dataDir = process.env.DATA_DIR?.trim()
    ? (path.isAbsolute(process.env.DATA_DIR.trim())
      ? process.env.DATA_DIR.trim()
      : path.join(process.cwd(), process.env.DATA_DIR.trim()))
    : path.join(process.cwd(), 'data');

  return path.join(dataDir, 'mock-data.db');
}

export async function GET() {
  const dbPath = resolveDbPath();

  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'development',
    db: {
      path: dbPath,
      exists: fs.existsSync(dbPath),
      directoryWritable: fs.existsSync(path.dirname(dbPath)),
    },
  });
}

import { DbApiConfig } from './types';

const DB_API_DRAFT_PREFIX = 'db-api:draft:';

export function createDbApiDraftKey(seed?: string | null): string {
  const suffix = seed?.trim() || Math.random().toString(36).slice(2, 10);
  return `${DB_API_DRAFT_PREFIX}${suffix}`;
}

export function isDbApiDraftKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(DB_API_DRAFT_PREFIX);
}

export function readDbApiDraft(key: string | null | undefined): DbApiConfig | null {
  if (typeof window === 'undefined' || !isDbApiDraftKey(key)) return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as DbApiConfig;
  } catch {
    return null;
  }
}

export function writeDbApiDraft(key: string, draft: DbApiConfig) {
  if (typeof window === 'undefined' || !isDbApiDraftKey(key)) return;
  window.sessionStorage.setItem(key, JSON.stringify(draft));
}

export function clearDbApiDraft(key: string | null | undefined) {
  if (typeof window === 'undefined' || !isDbApiDraftKey(key)) return;
  window.sessionStorage.removeItem(key);
}

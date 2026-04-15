import { isRecord, parseJsonSafely } from './db-harness/core/utils';

const MONGO_COUNT_DOCUMENTS_PATTERN = /^db\.([A-Za-z0-9_]+)\.countDocuments\s*\(([\s\S]*)\)\s*;?\s*$/;

export function normalizeMongoQueryText(query: string): string {
  const trimmed = query.trim().replace(/;+\s*$/, '');
  const match = trimmed.match(MONGO_COUNT_DOCUMENTS_PATTERN);
  if (!match) {
    return trimmed;
  }

  const collection = match[1];
  const rawFilter = match[2].trim();
  const parsedFilter = rawFilter ? parseJsonSafely(rawFilter) : {};
  const filter = isRecord(parsedFilter) ? parsedFilter : {};

  return JSON.stringify(
    {
      collection,
      operation: 'count',
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    },
    null,
    2
  );
}

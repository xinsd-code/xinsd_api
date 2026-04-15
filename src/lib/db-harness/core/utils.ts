export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonSafely(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function compactJson(value: unknown, maxLength = 20000): string {
  const text = JSON.stringify(value);
  if (!text) return 'null';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

export function compactText(value: string | null | undefined, maxLength = 2400): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(empty)';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

export function dedupeStrings(values: Array<string | null | undefined>, maxLength = 60): string[] {
  const seen = new Set<string>();
  const next: string[] = [];

  values.forEach((value) => {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const normalized = text.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    next.push(text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`);
  });

  return next;
}

export function extractJsonPayload(content: string): string {
  const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(start, end + 1);
  }

  throw new Error('AI 未返回可解析的 JSON 内容');
}

export function getModelErrorMessage(upstreamJson: unknown): string {
  return isRecord(upstreamJson) && isRecord(upstreamJson.error) && typeof upstreamJson.error.message === 'string'
    ? upstreamJson.error.message
    : '模型请求失败';
}

export function buildKeywordSet(...values: Array<string | null | undefined>): Set<string> {
  const keywords = new Set<string>();

  values.forEach((value) => {
    const matches = (value || '').toLowerCase().match(/[\p{Script=Han}a-z0-9_]+/gu) || [];
    matches
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .forEach((item) => keywords.add(item));
  });

  return keywords;
}

export function truncateText(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function scoreTextByKeywords(value: string | undefined, keywords: Set<string>): number {
  if (!value || keywords.size === 0) return 0;
  const normalized = value.toLowerCase();
  let score = 0;
  keywords.forEach((keyword) => {
    if (normalized.includes(keyword)) {
      score += keyword.length >= 4 ? 4 : 2;
    }
  });
  return score;
}

export function isLikelyModelUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const errorName = error instanceof Error ? error.name.toLowerCase() : '';
  return (
    errorName === 'timeouterror'
    || errorName === 'aborterror'
    || message.includes('超时')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('aborted due to timeout')
    || message.includes('operation was aborted')
    || message.includes('fetch failed')
    || message.includes('econnrefused')
    || message.includes('模型请求失败')
  );
}

export function isNumericType(type: string): boolean {
  return /int|decimal|numeric|float|double|real|serial|number|bigint|smallint/i.test(type);
}

export function isDateLikeType(type: string): boolean {
  return /date|time|timestamp|datetime/i.test(type);
}

export function isTextLikeType(type: string): boolean {
  return /char|text|json|uuid|enum|set/i.test(type);
}

export function quoteIdentifier(engine: DatabaseInstanceType, name: string): string {
  const parts = name.split('.');
  return parts.map((part) => (engine === 'mysql' ? `\`${part}\`` : `"${part}"`)).join('.');
}

export function extractTimeRangeDays(question: string): number | null {
  const match = question.match(/近\s*(\d+)\s*天|最近\s*(\d+)\s*天/i);
  const raw = match?.[1] || match?.[2];
  if (!raw) return null;
  const next = Number.parseInt(raw, 10);
  return Number.isFinite(next) && next > 0 ? next : null;
}

export function summarizeTopValues(row: Record<string, unknown> | undefined, columns: string[]): string {
  if (!row || columns.length === 0) return '';
  return columns
    .slice(0, 3)
    .map((column) => `${column}=${compactText(String(row[column] ?? '—'), 24)}`)
    .join('，');
}
import type { DatabaseInstanceType } from '@/lib/types';

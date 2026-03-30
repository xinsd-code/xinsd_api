import { DatabaseInstanceType } from './types';

const CJK_TOKEN_PATTERN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;
const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const SQL_ALIAS_BOUNDARY_PATTERN = /(\bAS\s+)(.+?)(?=(?:,|\r?\n|$|\s+(?:FROM|WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|ON|OFFSET|FETCH)\b))/gis;

function isQuotedIdentifier(value: string): boolean {
  return (
    (value.startsWith('`') && value.endsWith('`'))
    || (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('[') && value.endsWith(']'))
  );
}

function compactAliasLabel(value: string): string {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return value.trim();

  let nextValue = '';
  let previousWasCjk = false;

  for (const token of tokens) {
    if (CJK_TOKEN_PATTERN.test(token)) {
      nextValue += token;
      previousWasCjk = true;
      continue;
    }

    if (ASCII_IDENTIFIER_PATTERN.test(token)) {
      nextValue += nextValue
        ? `${previousWasCjk ? ' ' : ' '}${token}`
        : token;
      previousWasCjk = false;
      continue;
    }

    nextValue += nextValue ? ` ${token}` : token;
    previousWasCjk = false;
  }

  return nextValue;
}

function quoteAlias(type: Extract<DatabaseInstanceType, 'mysql' | 'pgsql'>, value: string): string {
  if (type === 'mysql') {
    return `\`${value.replace(/`/g, '``')}\``;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeAlias(type: Extract<DatabaseInstanceType, 'mysql' | 'pgsql'>, rawAlias: string): string {
  const trimmed = rawAlias.trim();
  if (!trimmed || isQuotedIdentifier(trimmed)) {
    return trimmed;
  }

  const compacted = compactAliasLabel(trimmed);
  if (SIMPLE_IDENTIFIER_PATTERN.test(compacted)) {
    return compacted;
  }

  return quoteAlias(type, compacted);
}

function normalizeAsAliases(type: Extract<DatabaseInstanceType, 'mysql' | 'pgsql'>, sql: string): string {
  return sql.replace(SQL_ALIAS_BOUNDARY_PATTERN, (_full, prefix: string, alias: string) => {
    const normalizedAlias = normalizeAlias(type, alias);
    return `${prefix}${normalizedAlias}`;
  });
}

export function normalizeSqlForExecution(type: DatabaseInstanceType, sql: string): string {
  if (type !== 'mysql' && type !== 'pgsql') {
    return sql;
  }

  return normalizeAsAliases(type, sql);
}

type SqlTokenType = 'word' | 'string' | 'template' | 'symbol' | 'operator' | 'comment';

interface SqlToken {
  type: SqlTokenType;
  value: string;
  upper?: string;
}

const SQL_IDENTIFIER_CHAR = /[\p{L}\p{N}_$.[\]]/u;

function tokenizeSql(input: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const text = input.replace(/\r\n/g, '\n');
  let index = 0;

  const pushWord = (value: string) => {
    tokens.push({ type: 'word', value, upper: value.toUpperCase() });
  };

  while (index < text.length) {
    const char = text[index];
    const nextChar = text[index + 1] || '';

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '{' && nextChar === '{') {
      const endIndex = text.indexOf('}}', index + 2);
      const value = endIndex === -1 ? text.slice(index) : text.slice(index, endIndex + 2);
      tokens.push({ type: 'template', value });
      index += value.length;
      continue;
    }

    if (char === '-' && nextChar === '-') {
      const endIndex = text.indexOf('\n', index + 2);
      const value = endIndex === -1 ? text.slice(index) : text.slice(index, endIndex);
      tokens.push({ type: 'comment', value });
      index += value.length;
      continue;
    }

    if (char === '/' && nextChar === '*') {
      const endIndex = text.indexOf('*/', index + 2);
      const value = endIndex === -1 ? text.slice(index) : text.slice(index, endIndex + 2);
      tokens.push({ type: 'comment', value });
      index += value.length;
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      let cursor = index + 1;
      let value = quote;

      while (cursor < text.length) {
        const current = text[cursor];
        value += current;
        if (current === '\\') {
          cursor += 1;
          if (cursor < text.length) {
            value += text[cursor];
          }
        } else if (current === quote) {
          if (quote === '\'' && text[cursor + 1] === '\'') {
            cursor += 1;
            value += text[cursor];
          } else {
            break;
          }
        }
        cursor += 1;
      }

      tokens.push({ type: 'string', value });
      index += value.length;
      continue;
    }

    if ('(),;'.includes(char)) {
      tokens.push({ type: 'symbol', value: char });
      index += 1;
      continue;
    }

    const operatorPair = `${char}${nextChar}`;
    if (['<=', '>=', '<>', '!=', '||', '::'].includes(operatorPair)) {
      tokens.push({ type: 'operator', value: operatorPair });
      index += 2;
      continue;
    }

    if ('=<>+-*/%'.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    let cursor = index;
    while (cursor < text.length && SQL_IDENTIFIER_CHAR.test(text[cursor])) {
      cursor += 1;
    }

    if (cursor > index) {
      pushWord(text.slice(index, cursor));
      index = cursor;
      continue;
    }

    tokens.push({ type: 'word', value: char, upper: char.toUpperCase() });
    index += 1;
  }

  return tokens;
}

function mergeSqlClauses(tokens: SqlToken[]): SqlToken[] {
  const merged: SqlToken[] = [];
  let index = 0;

  const clauses = [
    ['UNION', 'ALL'],
    ['ORDER', 'BY'],
    ['GROUP', 'BY'],
    ['INSERT', 'INTO'],
    ['DELETE', 'FROM'],
    ['LEFT', 'JOIN'],
    ['RIGHT', 'JOIN'],
    ['INNER', 'JOIN'],
    ['FULL', 'JOIN'],
    ['CROSS', 'JOIN'],
    ['LEFT', 'OUTER', 'JOIN'],
    ['RIGHT', 'OUTER', 'JOIN'],
    ['IS', 'NULL'],
    ['IS', 'NOT', 'NULL'],
  ];

  while (index < tokens.length) {
    const current = tokens[index];
    if (current.type !== 'word') {
      merged.push(current);
      index += 1;
      continue;
    }

    const matched = clauses.find((parts) => (
      parts.every((part, offset) => tokens[index + offset]?.type === 'word' && tokens[index + offset]?.upper === part)
    ));

    if (matched) {
      merged.push({
        type: 'word',
        value: matched.join(' '),
        upper: matched.join(' '),
      });
      index += matched.length;
      continue;
    }

    merged.push(current);
    index += 1;
  }

  return merged;
}

function isCompactCjkAliasToken(value: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(value);
}

function isAsciiAliasToken(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

function compactAliasWords(values: string[]): string {
  let nextValue = '';
  let previousWasCjk = false;

  for (const value of values) {
    if (!value) continue;
    if (isCompactCjkAliasToken(value)) {
      nextValue += value;
      previousWasCjk = true;
      continue;
    }

    if (isAsciiAliasToken(value)) {
      const shouldCompactAscii = previousWasCjk && /^[A-Z0-9_]+$/.test(value);
      nextValue += nextValue ? `${shouldCompactAscii ? '' : ' '}${value}` : value;
      previousWasCjk = false;
      continue;
    }

    nextValue += nextValue ? ` ${value}` : value;
    previousWasCjk = false;
  }

  return nextValue;
}

export function formatSqlDraft(input: string): string {
  const source = input.replace(/\r\n/g, '\n').trim();
  if (!source) return '';

  const tokens = mergeSqlClauses(tokenizeSql(source));
  const lines: string[] = [];
  const clauseListModes = new Set(['WITH', 'SELECT', 'SET', 'VALUES', 'GROUP BY', 'ORDER BY']);
  const clauseInlineModes = new Set([
    'FROM',
    'WHERE',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'UPDATE',
    'INSERT INTO',
    'DELETE FROM',
    'JOIN',
    'LEFT JOIN',
    'RIGHT JOIN',
    'INNER JOIN',
    'FULL JOIN',
    'CROSS JOIN',
    'LEFT OUTER JOIN',
    'RIGHT OUTER JOIN',
    'ON',
    'UNION',
    'UNION ALL',
  ]);
  const conditionWords = new Set(['AND', 'OR']);
  const minorKeywords = new Set([
    'AS',
    'ASC',
    'DESC',
    'DISTINCT',
    'IN',
    'NOT',
    'LIKE',
    'BETWEEN',
    'EXISTS',
    'NULL',
    'TRUE',
    'FALSE',
    'IS NULL',
    'IS NOT NULL',
  ]);
  const majorClauses = new Set([...clauseListModes, ...clauseInlineModes]);
  let currentLine = '';
  let indentLevel = 0;
  let clauseMode: string | null = null;
  let caseDepth = 0;

  const indent = (level = indentLevel) => '  '.repeat(Math.max(0, level));
  const pushLine = () => {
    const normalized = currentLine.replace(/[ \t]+$/g, '');
    if (normalized.trim()) {
      lines.push(normalized);
    }
    currentLine = '';
  };
  const ensureLine = (level = indentLevel) => {
    if (!currentLine) currentLine = indent(level);
  };
  const inListClause = () => Boolean(clauseMode && clauseListModes.has(clauseMode));
  const getLineIndentLevel = () => (inListClause() ? indentLevel + 1 : indentLevel);
  const getCaseIndentLevel = (extra = 0) => (inListClause() ? indentLevel + 1 + extra : indentLevel + extra);
  const normalizeTokenValue = (value: string, mode: 'compact' | 'preserve' = 'compact') => (
    mode === 'preserve' ? value.trim() : value.replace(/\s+/g, ' ').trim()
  );
  const appendValue = (value: string, options?: { noSpace?: boolean; preserveWhitespace?: boolean }) => {
    ensureLine(getLineIndentLevel());
    const nextValue = normalizeTokenValue(value, options?.preserveWhitespace ? 'preserve' : 'compact');
    if (!nextValue) return;
    const endsWithSpace = /\s$/.test(currentLine);
    const endsWithOpen = /[(]$/.test(currentLine);
    const startsWithClose = /^[),;]/.test(nextValue);
    const startsWithOperator = /^(=|<>|!=|<=|>=|<|>|\+|-|\*|\/|%|\|\|)/.test(nextValue);
    const previousIsOperator = /(=|<>|!=|<=|>=|<|>|\+|-|\*|\/|%|\|\|)\s*$/.test(currentLine);

    if (!options?.noSpace && !endsWithSpace && !endsWithOpen && !startsWithClose) {
      currentLine += startsWithOperator || previousIsOperator ? ' ' : ' ';
    }
    currentLine += nextValue;
  };

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const upper = token.upper || token.value.toUpperCase();

    if (token.type === 'comment') {
      pushLine();
      currentLine = `${indent()}${token.value}`;
      pushLine();
      continue;
    }

    if (token.type === 'symbol' && token.value === ';') {
      appendValue(';', { noSpace: true });
      pushLine();
      clauseMode = null;
      continue;
    }

    if (token.type === 'symbol' && token.value === ',') {
      appendValue(',', { noSpace: true });
      if (clauseMode) {
        pushLine();
      }
      continue;
    }

    if (token.type === 'symbol' && token.value === '(') {
      const allowSpaceBeforeOpen = /\bAS$/.test(currentLine.trimEnd());
      appendValue('(', { noSpace: !allowSpaceBeforeOpen });
      indentLevel += 1;
      continue;
    }

    if (token.type === 'symbol' && token.value === ')') {
      indentLevel = Math.max(0, indentLevel - 1);
      if (!currentLine.trim()) {
        currentLine = indent();
      }
      appendValue(')', { noSpace: true });
      continue;
    }

    if (token.type === 'word' && majorClauses.has(upper)) {
      pushLine();
      currentLine = `${indent()}${upper}`;
      if (clauseListModes.has(upper)) {
        pushLine();
        currentLine = indent(indentLevel + 1);
        clauseMode = upper;
      } else {
        clauseMode = clauseInlineModes.has(upper) ? upper : null;
      }
      continue;
    }

    if (token.type === 'word' && conditionWords.has(upper) && ['WHERE', 'HAVING', 'ON'].includes(clauseMode || '')) {
      pushLine();
      currentLine = `${indent(indentLevel + 1)}${upper}`;
      continue;
    }

    if (token.type === 'word' && upper === 'CASE') {
      appendValue('CASE');
      caseDepth += 1;
      indentLevel += 1;
      continue;
    }

    if (token.type === 'word' && upper === 'WHEN' && caseDepth > 0) {
      pushLine();
      currentLine = `${indent(getCaseIndentLevel())}WHEN`;
      continue;
    }

    if (token.type === 'word' && upper === 'THEN' && caseDepth > 0) {
      appendValue('THEN');
      continue;
    }

    if (token.type === 'word' && upper === 'ELSE' && caseDepth > 0) {
      pushLine();
      currentLine = `${indent(getCaseIndentLevel())}ELSE`;
      continue;
    }

    if (token.type === 'word' && upper === 'END' && caseDepth > 0) {
      indentLevel = Math.max(0, indentLevel - 1);
      pushLine();
      currentLine = `${indent(getCaseIndentLevel())}END`;
      caseDepth = Math.max(0, caseDepth - 1);
      continue;
    }

    if (token.type === 'operator') {
      appendValue(token.value);
      continue;
    }

    if (token.type === 'word' && upper === 'AS') {
      appendValue('AS');

      const aliasWords: string[] = [];
      let nextIndex = tokenIndex + 1;
      while (nextIndex < tokens.length) {
        const nextToken = tokens[nextIndex];
        const nextUpper = nextToken.upper || nextToken.value.toUpperCase();
        if (
          nextToken.type !== 'word'
          || majorClauses.has(nextUpper)
          || minorKeywords.has(nextUpper)
          || conditionWords.has(nextUpper)
        ) {
          break;
        }
        aliasWords.push(nextToken.value);
        nextIndex += 1;
      }

      if (aliasWords.length > 0) {
        appendValue(compactAliasWords(aliasWords));
        tokenIndex = nextIndex - 1;
      }
      continue;
    }

    appendValue(token.type === 'word'
      ? (majorClauses.has(upper) || minorKeywords.has(upper) ? upper : token.value)
      : token.value, {
      preserveWhitespace: token.type === 'string' || token.type === 'template',
    });
  }

  pushLine();

  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

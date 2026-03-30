'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '@/components/Icons';
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog';
import { flattenAIModelSelections, getAIModelSelectionKey, getDefaultAIModelSelection } from '@/lib/ai-models';
import { sanitizeDatabaseMetricMappings } from '@/lib/database-instances';
import { readDbApiDraft, writeDbApiDraft } from '@/lib/db-api-draft';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { extractSqlVariables } from '@/lib/sql-template';
import {
  AIModelProfile,
  AIModelSelection,
  DatabaseCollectionInfo,
  DatabaseInstanceSummary,
  DatabaseQueryPayload,
  DatabaseSchemaPayload,
  DbApiConfig,
  SqlVariableBinding,
} from '@/lib/types';
import styles from './page.module.css';

interface DatabaseFieldMetricView {
  metricName?: string;
  description?: string;
  metricType?: string;
  calcMode?: string;
}

interface DatabaseTableMetricView {
  description?: string;
  fields: Record<string, DatabaseFieldMetricView>;
}

type DatabaseMetricViewMap = Record<string, DatabaseTableMetricView>;

interface DatabaseInstanceMetricPayload {
  metricMappings?: unknown;
}

interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  sql?: string;
  prompt?: string;
  variables?: string[];
}

interface AiChatResultPayload {
  message?: string;
  sql?: string;
  variables?: string[];
  prompt?: string;
}

const AI_SQL_SUGGESTIONS = [
  '帮我写一个按时间倒序的查询，并保留最近 10 条记录',
  '结合已有指标名，生成一个适合接口返回的统计 SQL',
  '根据当前表结构生成一个可直接绑定 API 入参的查询模版',
];

function generateChatMessageId(): string {
  return 'm_' + Math.random().toString(36).slice(2, 10);
}

function getModelOptionLabel(model: Pick<AIModelSelection, 'profileName' | 'modelId'>): string {
  return `${model.profileName} / ${model.modelId}`;
}

function parseSseBlocks(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  let remaining = buffer;

  let boundaryIndex = remaining.indexOf('\n\n');
  while (boundaryIndex !== -1) {
    const block = remaining.slice(0, boundaryIndex);
    remaining = remaining.slice(boundaryIndex + 2);

    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length > 0) {
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');

      if (data) {
        events.push({ event, data });
      }
    }

    boundaryIndex = remaining.indexOf('\n\n');
  }

  return { events, rest: remaining };
}

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
      nextValue += nextValue
        ? `${shouldCompactAscii ? '' : ' '}${value}`
        : value;
      previousWasCjk = false;
      continue;
    }

    nextValue += nextValue ? ` ${value}` : value;
    previousWasCjk = false;
  }

  return nextValue;
}

function formatSqlDraft(input: string): string {
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
  const normalizeTokenValue = (value: string, mode: 'compact' | 'preserve' = 'compact') => {
    if (mode === 'preserve') {
      return value.trim();
    }
    return value.replace(/\s+/g, ' ').trim();
  };
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

function buildMetricTooltip(
  mapping: DatabaseFieldMetricView | null | undefined,
  columnName: string
): string {
  if (!mapping) return columnName;
  const lines = [
    `字段: ${columnName}`,
    mapping.metricName ? `指标名称: ${mapping.metricName}` : null,
    mapping.description ? `指标描述: ${mapping.description}` : null,
    mapping.metricType ? `指标类型: ${mapping.metricType}` : null,
    mapping.calcMode ? `计算方式: ${mapping.calcMode}` : null,
  ].filter((item): item is string => Boolean(item));

  return lines.join('\n');
}

function MetricBadge({
  label,
  tooltip,
  muted = false,
}: {
  label: string;
  tooltip: string;
  muted?: boolean;
}) {
  return (
    <span className={styles.metricTooltipWrap}>
      <span className={`${styles.metricBadge} ${muted ? styles.muted : ''}`} title={tooltip}>
        {label}
      </span>
      <span className={styles.metricTooltip}>{tooltip}</span>
    </span>
  );
}

function getInitialRunParams(config: DbApiConfig, sqlVariables: string[]): Record<string, string> {
  return sqlVariables.reduce<Record<string, string>>((accumulator, variableKey) => {
    const binding = config.paramBindings.find((item) => item.variableKey === variableKey);
    if (binding?.staticValue !== undefined) {
      accumulator[variableKey] = binding.staticValue;
      return accumulator;
    }

    const boundParam = config.customParams.find((item) => item.key === binding?.customParamKey);
    if (boundParam?.defaultValue) {
      accumulator[variableKey] = boundParam.defaultValue;
      return accumulator;
    }

    const sameNameParam = config.customParams.find((item) => item.key === variableKey);
    if (sameNameParam?.defaultValue) {
      accumulator[variableKey] = sameNameParam.defaultValue;
      return accumulator;
    }

    accumulator[variableKey] = '';
    return accumulator;
  }, {});
}

function buildExecutionRunParams(
  config: DbApiConfig,
  sqlVariables: string[],
  runParams: Record<string, string>
): Record<string, string> {
  return sqlVariables.reduce<Record<string, string>>((accumulator, variableKey) => {
    const nextValue = runParams[variableKey] ?? '';
    const binding = config.paramBindings.find((item) => item.variableKey === variableKey);
    accumulator[variableKey] = nextValue;
    if (binding?.customParamKey) {
      accumulator[binding.customParamKey] = nextValue;
    }
    return accumulator;
  }, {});
}

function PreviewResultPanel({
  payload,
}: {
  payload: ({ status?: number; error?: string; _meta?: Record<string, unknown> } & Partial<DatabaseQueryPayload>) | null;
}) {
  if (!payload) {
    return (
      <div style={{ padding: 28, color: 'var(--color-text-muted)', textAlign: 'center' }}>
        运行 SQL 预览后，这里会在左侧展示 SQL / 绑定 / 缓存信息，右侧展示数据与接口返回预览。
      </div>
    );
  }

  const columns = payload.columns || [];
  const rows = payload.rows || [];
  const meta = payload._meta || {};
  const responsePreview = payload.error
    ? {
      status: payload.status || 500,
      error: payload.error,
    }
    : {
      status: payload.status || 200,
      data: rows,
      columns,
      summary: payload.summary || `共返回 ${rows.length} 行`,
    };

  return (
    <div className={styles.previewLayout}>
      <div className={styles.previewAside}>
        {'previewSql' in meta && (
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icons.Code size={16} />
              <strong style={{ fontSize: 14 }}>执行预览 SQL</strong>
            </div>
            <pre className={styles.previewCodeBlock}>{String(meta.previewSql || '')}</pre>
          </div>
        )}

        {'resolvedBindings' in meta && (
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icons.Layers size={16} />
              <strong style={{ fontSize: 14 }}>绑定明细</strong>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Array.isArray(meta.resolvedBindings) && meta.resolvedBindings.length > 0 ? (
                (meta.resolvedBindings as Array<{ variableKey: string; source: string; value: unknown }>).map((item) => (
                  <div key={item.variableKey} className={styles.bindingCard}>
                    <strong>{item.variableKey}</strong>
                    <span style={{ color: 'var(--color-text-muted)' }}>{item.source}</span>
                    <code style={{ overflowWrap: 'anywhere' }}>{JSON.stringify(item.value)}</code>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>当前没有变量绑定。</div>
              )}
            </div>
          </div>
        )}

        {'cache' in meta && (
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icons.Database size={16} />
              <strong style={{ fontSize: 14 }}>Redis 缓存状态</strong>
            </div>
            <pre className={styles.previewCodeBlock}>{JSON.stringify(meta.cache, null, 2)}</pre>
          </div>
        )}
      </div>

      <div className={styles.previewMain}>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.Activity size={16} />
              <strong style={{ fontSize: 14 }}>SQL 数据预览</strong>
            </div>
            {!payload.error && (
              <span className={styles.previewBadge}>{payload.summary || `共返回 ${rows.length} 行`}</span>
            )}
          </div>

          {payload.error ? (
            <pre className={styles.previewError}>{payload.error}</pre>
          ) : rows.length === 0 ? (
            <div className={styles.previewEmpty}>查询成功，但当前没有返回数据。</div>
          ) : (
            <div className={styles.previewTableWrap}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--color-bg-subtle)' }}>
                    {columns.map((column) => (
                      <th
                        key={column}
                        style={{
                          textAlign: 'left',
                          padding: '10px 12px',
                          borderBottom: '1px solid var(--color-border)',
                          fontWeight: 700,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {columns.map((column) => (
                        <td
                          key={`${rowIndex}-${column}`}
                          style={{
                            padding: '10px 12px',
                            borderBottom: '1px solid var(--color-border)',
                            verticalAlign: 'top',
                            fontFamily: 'var(--font-mono)',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {JSON.stringify(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.Server size={16} />
              <strong style={{ fontSize: 14 }}>接口返回预览</strong>
            </div>
            <span className={styles.previewBadge}>HTTP {payload.status || '--'}</span>
          </div>
          <pre className={styles.previewCodeBlock}>{JSON.stringify(responsePreview, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}

export default function DbApiEditorPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const [navigationState, setNavigationState] = useState<{ draftKey: string | null; returnEditId: string | null }>({
    draftKey: null,
    returnEditId: null,
  });
  const [navigationReady, setNavigationReady] = useState(false);
  const draftKey = navigationState.draftKey;
  const returnEditId = navigationState.returnEditId;

  const [config, setConfig] = useState<DbApiConfig | null>(null);
  const [sqlDraft, setSqlDraft] = useState('');
  const [runParams, setRunParams] = useState<Record<string, string>>({});
  const [schema, setSchema] = useState<DatabaseSchemaPayload | null>(null);
  const [databaseInstanceName, setDatabaseInstanceName] = useState('');
  const [metricMappings, setMetricMappings] = useState<DatabaseMetricViewMap>({});
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [result, setResult] = useState<({ status?: number; error?: string; _meta?: Record<string, unknown> } & Partial<DatabaseQueryPayload>) | null>(null);
  const [previewLimit, setPreviewLimit] = useState('10');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [modelProfiles, setModelProfiles] = useState<AIModelProfile[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [activeModelKey, setActiveModelKey] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelReminderOpen, setModelReminderOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [latestSqlExpanded, setLatestSqlExpanded] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [lastResolvedPrompt, setLastResolvedPrompt] = useState('');
  const [chatMessages, setChatMessages] = useState<AiChatMessage[]>([
    {
      id: generateChatMessageId(),
      role: 'assistant',
      content: '我会结合数据库表结构、字段指标、整表说明和当前 SQL 草稿，把自然语言需求改写成可直接运行的 SQL。',
    },
  ]);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const chatMessagesRef = useRef<HTMLDivElement | null>(null);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);

  const sqlVariables = useMemo(() => extractSqlVariables(sqlDraft), [sqlDraft]);

  const selectedInfo = useMemo<DatabaseCollectionInfo | null>(
    () => schema?.collections.find((item) => item.name === selectedCollection) || null,
    [schema?.collections, selectedCollection]
  );

  const tableCollections = useMemo(
    () => (schema?.collections || []).filter((item) => item.category === 'table'),
    [schema?.collections]
  );
  const selectedTableMetrics = useMemo<DatabaseTableMetricView | null>(
    () => (selectedCollection ? metricMappings[selectedCollection] || null : null),
    [metricMappings, selectedCollection]
  );
  const modelOptions = useMemo(() => flattenAIModelSelections(modelProfiles), [modelProfiles]);
  const defaultModelOption = useMemo(() => getDefaultAIModelSelection(modelProfiles), [modelProfiles]);
  const activeModel = useMemo(() => {
    const matched = modelOptions.find((item) => getAIModelSelectionKey(item) === activeModelKey);
    return matched || defaultModelOption || null;
  }, [activeModelKey, defaultModelOption, modelOptions]);
  const latestUserInstruction = useMemo(
    () => [...chatMessages].reverse().find((message) => message.role === 'user')?.content || '',
    [chatMessages]
  );
  const latestGeneratedSql = useMemo(
    () => [...chatMessages].reverse().find((message) => typeof message.sql === 'string' && message.sql.trim())?.sql || '',
    [chatMessages]
  );
  const isDirty = useMemo(
    () => Boolean(config) && sqlDraft !== (config?.sqlTemplate || ''),
    [config, sqlDraft]
  );

  const backHref = useMemo(() => {
    const query = new URLSearchParams();
    if (draftKey) query.set('draft', draftKey);
    if (returnEditId) {
      query.set('edit', returnEditId);
    } else if (id !== 'draft') {
      query.set('edit', id);
    }
    return `/db-api${query.toString() ? `?${query.toString()}` : ''}`;
  }, [draftKey, id, returnEditId]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const currentSearch = new URLSearchParams(window.location.search);
    setNavigationState({
      draftKey: currentSearch.get('draft'),
      returnEditId: currentSearch.get('edit'),
    });
    setNavigationReady(true);
  }, []);

  useEffect(() => {
    if (modelOptions.length === 0) {
      setActiveModelKey(null);
      return;
    }

    if (activeModelKey && modelOptions.some((item) => getAIModelSelectionKey(item) === activeModelKey)) {
      return;
    }

    if (defaultModelOption) {
      setActiveModelKey(getAIModelSelectionKey(defaultModelOption));
      return;
    }

    setActiveModelKey(getAIModelSelectionKey(modelOptions[0]));
  }, [activeModelKey, defaultModelOption, modelOptions]);

  useEffect(() => {
    if (!chatOpen) {
      setModelPickerOpen(false);
      return;
    }
    const chatContainer = chatMessagesRef.current;
    if (!chatContainer) return;
    const frame = window.requestAnimationFrame(() => {
      chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: chatLoading ? 'auto' : 'smooth',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chatLoading, chatMessages, chatOpen]);

  useEffect(() => {
    if (!(chatOpen || modelReminderOpen) || typeof document === 'undefined') return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [chatOpen, modelReminderOpen]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const clickedInsidePicker = modelPickerRef.current
        ? eventPath.includes(modelPickerRef.current)
        : false;

      if (!clickedInsidePicker) {
        setModelPickerOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [modelPickerOpen]);

  const loadModelProfiles = useCallback(async () => {
    try {
      setModelLoading(true);
      const res = await fetch('/api/ai-models');
      if (!res.ok) {
        throw new Error('获取模型配置失败');
      }
      const payload = await res.json() as AIModelProfile[];
      setModelProfiles(payload);
      return payload;
    } catch (error) {
      setChatMessages((current) => (
        current.some((item) => item.error && item.content.includes('获取模型配置失败'))
          ? current
          : [
              ...current,
              {
                id: generateChatMessageId(),
                role: 'assistant',
                content: error instanceof Error ? error.message : '获取模型配置失败',
                error: true,
              },
            ]
      ));
      return [];
    } finally {
      setModelLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModelProfiles();
  }, [loadModelProfiles]);

  useEffect(() => {
    if (!navigationReady) return;
    const load = async () => {
      try {
        setIsLoading(true);
        let nextConfig: DbApiConfig | null = null;

        if (draftKey) {
          nextConfig = readDbApiDraft(draftKey);
        }

        if (!nextConfig && id !== 'draft') {
          const response = await fetch(`/api/db-apis/${id}`);
          const detail = (await response.json()) as DbApiConfig | { error?: string };
          if (!response.ok) {
            const detailError = (detail as { error?: string }).error;
            throw new Error(typeof detailError === 'string' ? detailError : '读取 DB API 失败');
          }
          nextConfig = detail as DbApiConfig;
        }

        if (!nextConfig) {
          throw new Error('当前没有可用的 DB API 草稿，请返回主配置页重新进入');
        }

        const variables = extractSqlVariables(nextConfig.sqlTemplate || '');
        setConfig(nextConfig);
        setSqlDraft(nextConfig.sqlTemplate || '');
        setRunParams(getInitialRunParams(nextConfig, variables));

        if (!nextConfig.databaseInstanceId) {
          setSchema(null);
          setDatabaseInstanceName('');
          setMetricMappings({});
          return;
        }

        const [schemaResponse, instanceResponse] = await Promise.all([
          fetch(`/api/database-instances/${nextConfig.databaseInstanceId}/schema`),
          fetch(`/api/database-instances/${nextConfig.databaseInstanceId}`),
        ]);

        const schemaPayload = (await schemaResponse.json()) as DatabaseSchemaPayload | { error?: string };
        if (schemaResponse.ok) {
          const nextSchema = schemaPayload as DatabaseSchemaPayload;
          setSchema(nextSchema);
          setSelectedCollection(nextSchema.collections.find((item) => item.category === 'table')?.name || null);
        } else {
          setDatabaseInstanceName('');
          const schemaError = (schemaPayload as { error?: string }).error;
          setSchema(null);
          showToast(typeof schemaError === 'string' ? schemaError : '读取数据库结构失败', 'error');
        }

        const instancePayload = (await instanceResponse.json()) as DatabaseInstanceMetricPayload | { error?: string };
        if (instanceResponse.ok) {
          const instanceDetail = instancePayload as DatabaseInstanceSummary & DatabaseInstanceMetricPayload;
          setDatabaseInstanceName(instanceDetail.name || '');
          setMetricMappings(
            sanitizeDatabaseMetricMappings(instanceDetail.metricMappings || {}) as DatabaseMetricViewMap
          );
        } else {
          setDatabaseInstanceName('');
          setMetricMappings({});
        }
      } catch (error) {
        console.error(error);
        showToast(error instanceof Error ? error.message : '初始化 SQL 编辑页失败', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    load().catch(console.error);
  }, [draftKey, id, navigationReady, showToast]);

  useEffect(() => {
    if (!config) return;
    setRunParams((current) => {
      const next = { ...getInitialRunParams({ ...config, sqlTemplate: sqlDraft }, sqlVariables), ...current };
      return sqlVariables.reduce<Record<string, string>>((accumulator, variableKey) => {
        accumulator[variableKey] = next[variableKey] ?? '';
        return accumulator;
      }, {});
    });
  }, [config, sqlDraft, sqlVariables]);

  useEffect(() => {
    if (!result) return;
    window.setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  }, [result]);

  const filteredCollections = useMemo(() => {
    const collections = tableCollections;
    if (!searchQuery.trim()) return collections;
    return collections.filter((item) => item.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [searchQuery, tableCollections]);

  const openChatPanel = async () => {
    const profiles = modelProfiles.length > 0 ? modelProfiles : await loadModelProfiles();
    const nextDefault = getDefaultAIModelSelection(profiles);
    if (!nextDefault) {
      setModelReminderOpen(true);
      return;
    }

    if (!activeModelKey) {
      setActiveModelKey(getAIModelSelectionKey(nextDefault));
    }

    setModelReminderOpen(false);
    setChatOpen(true);
  };

  const sendChatMessage = async (preset?: string, promptOverride?: string) => {
    const content = (preset ?? chatInput).trim();
    if (!content || chatLoading || !config) return;
    if (!activeModel) {
      setModelReminderOpen(true);
      return;
    }

    const nextUserMessage: AiChatMessage = {
      id: generateChatMessageId(),
      role: 'user',
      content,
    };
    const assistantMessageId = generateChatMessageId();
    const nextConversation = [
      ...chatMessages.map((message) => ({ role: message.role, content: message.content })),
      { role: nextUserMessage.role, content: nextUserMessage.content },
    ];

    setChatMessages((current) => [
      ...current,
      nextUserMessage,
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '正在读取当前表结构、指标配置和 SQL 草稿，并生成可直接回填的 SQL...',
      },
    ]);
    setChatInput('');
    setChatLoading(true);
    setChatOpen(true);

    try {
      const response = await fetch('/api/db-apis/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stream: true,
          messages: nextConversation,
          selectedModel: {
            profileId: activeModel.profileId,
            modelId: activeModel.modelId,
          },
          databaseInstanceId: config.databaseInstanceId,
          databaseEngine: schema?.engine,
          schema,
          metricMappings,
          currentSql: sqlDraft,
          customParams: config.customParams,
          promptOverride: promptOverride?.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const errorPayload = errorText ? JSON.parse(errorText) as { error?: string } : {};
          throw new Error(errorPayload.error || 'AI SQL 生成失败');
        } catch {
          throw new Error(errorText || 'AI SQL 生成失败');
        }
      }

      if (!response.body) {
        throw new Error('AI 流式响应不可用');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let previewText = '';

      const updateAssistantMessage = (message: string, error = false, extra?: Partial<AiChatMessage>) => {
        setChatMessages((current) => current.map((item) => (
          item.id === assistantMessageId
            ? { ...item, content: message, error, ...extra }
            : item
        )));
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;

        for (const block of parsed.events) {
          const payload = JSON.parse(block.data) as Record<string, unknown>;

          if (block.event === 'delta') {
            const chunk = typeof payload.content === 'string' ? payload.content : '';
            if (!chunk) continue;
            previewText += chunk;
            updateAssistantMessage(previewText);
            continue;
          }

          if (block.event === 'done') {
            const finalPayload = payload as AiChatResultPayload;
            const nextSql = typeof finalPayload.sql === 'string' ? finalPayload.sql.trim() : '';
            const nextVariables = Array.isArray(finalPayload.variables)
              ? finalPayload.variables.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              : [];
            const resolvedPrompt = typeof finalPayload.prompt === 'string' ? finalPayload.prompt.trim() : '';

            if (nextSql) {
              setSqlDraft(nextSql);
              showToast('AI SQL 已回填到编写区');
            }
            if (resolvedPrompt) {
              setLastResolvedPrompt(resolvedPrompt);
              setPromptDraft(resolvedPrompt);
            }

            const summaryLines = [
              typeof finalPayload.message === 'string' && finalPayload.message.trim()
                ? finalPayload.message.trim()
                : 'SQL 已生成并同步到编写区。',
              nextSql ? '已自动应用到 SQL 编写区。' : null,
              nextVariables.length > 0 ? `识别变量: ${nextVariables.map((item) => `{{${item}}}`).join('、')}` : null,
            ].filter((item): item is string => Boolean(item));

            updateAssistantMessage(summaryLines.join('\n\n'), false, {
              sql: nextSql || undefined,
              prompt: resolvedPrompt || undefined,
              variables: nextVariables,
            });
            continue;
          }

          if (block.event === 'error') {
            throw new Error(typeof payload.error === 'string' ? payload.error : 'AI 流式响应处理失败');
          }
        }
      }
    } catch (error) {
      console.error(error);
      setChatMessages((current) => current.map((item) => (
        item.id === assistantMessageId
          ? {
              ...item,
              content: error instanceof Error ? error.message : 'AI SQL 生成失败',
              error: true,
            }
          : item
      )));
      showToast(error instanceof Error ? error.message : 'AI SQL 生成失败', 'error');
    } finally {
      setChatLoading(false);
    }
  };

  const handleBeautifySql = useCallback(() => {
    const formatted = formatSqlDraft(sqlDraft);
    if (!formatted) {
      showToast('当前没有可美化的 SQL', 'error');
      return;
    }
    if (formatted === sqlDraft.trim()) {
      showToast('当前 SQL 已较为整洁');
      return;
    }

    setSqlDraft(formatted);
    showToast('SQL 已美化');
  }, [showToast, sqlDraft]);

  const handleRegenerateWithPrompt = async () => {
    const content = chatInput.trim() || latestUserInstruction;
    if (!content) {
      showToast('请先输入需求，或至少生成过一次 SQL', 'error');
      return;
    }

    await sendChatMessage(content, promptDraft.trim() || lastResolvedPrompt);
  };

  const handleRun = async () => {
    if (!config) return;

    setIsRunning(true);
    try {
      const executionRunParams = buildExecutionRunParams(config, sqlVariables, runParams);
      const response = await fetch('/api/db-apis/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            ...config,
            sqlTemplate: sqlDraft,
          },
          runParams: executionRunParams,
          previewLimit: previewLimit ? Number.parseInt(previewLimit, 10) : undefined,
        }),
      });
      const payload = await response.json();
      setResult({
        status: response.status,
        ...payload,
      });
      if (!response.ok) {
        showToast(payload.error || 'SQL 预览执行失败', 'error');
        return;
      }
      showToast('SQL 预览执行成功');
    } catch (error) {
      console.error(error);
      setResult({
        status: 500,
        error: error instanceof Error ? error.message : 'SQL 预览执行失败',
      });
      showToast('SQL 预览执行失败', 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!config) return false;

    setIsSaving(true);
    try {
      const validVariableSet = new Set(extractSqlVariables(sqlDraft));
      const nextBindings = (config.paramBindings || []).filter((item: SqlVariableBinding) =>
        validVariableSet.has(item.variableKey)
      );

      const nextConfig: DbApiConfig = {
        ...config,
        sqlTemplate: sqlDraft,
        paramBindings: nextBindings,
      };

      if (draftKey) {
        writeDbApiDraft(draftKey, nextConfig);
        setConfig(nextConfig);
        showToast('SQL 草稿已保存，返回主配置页即可继续绑定参数');
        return true;
      }

      const response = await fetch(`/api/db-apis/${config.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig),
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast(payload.error || '保存 SQL 失败', 'error');
        return false;
      }

      setConfig(payload as DbApiConfig);
      showToast('SQL 已保存，返回主配置页即可继续绑定参数');
      return true;
    } catch (error) {
      console.error(error);
      showToast('保存 SQL 失败', 'error');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [config, draftKey, showToast, sqlDraft]);

  const handleSave = useCallback(() => {
    void saveCurrent();
  }, [saveCurrent]);

  const unsavedGuard = useUnsavedChangesGuard({
    enabled: Boolean(config),
    isDirty,
    onSave: saveCurrent,
  });

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-muted)' }}>
          正在加载 SQL 编辑页...
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className={styles.page}>
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-muted)' }}>
          当前 DB API 不存在或读取失败。
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => unsavedGuard.confirmAction(() => router.push(backHref))}>
              <Icons.ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
              返回主配置页
            </button>
            <span className={`method-badge method-${config.method.toLowerCase()}`}>{config.method}</span>
          </div>
          <div className={styles.heroTitle}>{config.name || '未命名 DB API 草稿'}</div>
          <div className={styles.heroDesc}>
            在这里完成 SQL 编写、调试和表结构查看；保存后回到主配置页，即可基于识别出的 SQL 变量继续做 API 入参与缓存规则配置。
          </div>
          <div className={styles.heroMeta}>
              <span className={styles.metaBadge}>
                <Icons.Database size={14} />
              {databaseInstanceName || config.databaseInstanceId || '未选择数据库'}
              </span>
            <span className={styles.metaBadge}>
              <Icons.Server size={14} />
              /db-api{config.path}
            </span>
            <span className={styles.metaBadge}>
              <Icons.Code size={14} />
              {sqlVariables.length} 个 SQL 变量
            </span>
          </div>
        </div>

        <div className={styles.heroActions}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <strong style={{ fontSize: 14 }}>当前配置提示</strong>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.7 }}>
              运行预览会直接基于当前草稿执行，并按上限返回结果集；点击表只查看结构，不再预览表数据。
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--color-border)',
                background: 'rgba(255, 255, 255, 0.72)',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>预览上限</span>
              <input
                type="number"
                min={1}
                max={100}
                value={previewLimit}
                onChange={(event) => setPreviewLimit(event.target.value)}
                className="form-input"
                style={{ width: 84, height: 34, fontFamily: 'var(--font-mono)' }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>最多返回 10 条，可调。</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
              <Icons.Check size={16} />
              {isSaving ? '保存中...' : draftKey ? '保存 SQL 草稿' : '保存 SQL'}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong style={{ fontSize: 14 }}>当前运行入口</strong>
          <code style={{ fontSize: 12 }}>{`/db-api${config.path}`}</code>
        </div>
        <Link href={backHref} className="btn btn-secondary btn-sm">
          <Icons.Refresh size={14} />
          回主配置页做绑定
        </Link>
      </div>

      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div>
              <strong style={{ fontSize: 15 }}>表结构查看</strong>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                点选左侧表后，只展示字段结构，不再拉取样例数据。
              </div>
            </div>
            <div className="search-bar" style={{ maxWidth: '100%' }}>
              <Icons.Search className="search-bar-icon" size={14} />
              <input
                type="text"
                className="search-bar-input"
                style={{ height: 36 }}
                placeholder="搜索库表..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
          </div>

          <div className={styles.schemaList}>
            {filteredCollections.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12 }}>
                当前没有可展示的数据库表。
              </div>
            ) : (
              filteredCollections.map((collection) => {
                const tableMetric = metricMappings[collection.name];

                return (
                  <div
                    key={collection.name}
                    className={`${styles.schemaCard} ${selectedCollection === collection.name ? styles.active : ''}`}
                    onClick={() => setSelectedCollection(collection.name)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <strong style={{ fontSize: 13, lineHeight: 1.4 }}>{collection.name}</strong>
                      <span
                        style={{
                          padding: '4px 8px',
                          borderRadius: 999,
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          background: 'var(--color-bg-subtle)',
                          border: '1px solid var(--color-border)',
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        TABLE
                      </span>
                    </div>
                    <div className={styles.schemaCardMeta}>
                      <span>{collection.columns?.length || 0} 个字段</span>
                      {Object.keys(tableMetric?.fields || {}).length > 0 && (
                        <span>{Object.keys(tableMetric?.fields || {}).length} 项指标映射</span>
                      )}
                    </div>
                    {tableMetric?.description && (
                      <div className={styles.schemaDescription}>
                        {tableMetric.description}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <div className={styles.main}>
          <div className={styles.editorCard}>
            <div className={styles.editorWorkspace}>
              <div className={styles.selectionPanel}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <strong style={{ fontSize: 15 }}>已选库表</strong>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                      左侧选表后，这里只展示当前表的结构信息。
                    </div>
                  </div>
                  {selectedCollection && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        if (!selectedCollection) return;
                        const quotedName = selectedCollection.includes('.')
                          ? selectedCollection.split('.').map((part) => `"${part}"`).join('.')
                          : `"${selectedCollection}"`;
                        setSqlDraft((current) =>
                          current.trim()
                            ? current
                            : `SELECT *\nFROM ${quotedName}\nLIMIT 10;`
                        );
                      }}
                    >
                      <Icons.Plus size={14} />
                      插入模板
                    </button>
                  )}
                </div>

                {!selectedInfo ? (
                  <div className={styles.selectionEmpty}>
                    选择左侧库表后，可在这里查看字段定义并快速插入查询模板。
                  </div>
                ) : (
                  <>
                    <div className={styles.selectionHeader}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <strong style={{ fontSize: 14, fontFamily: 'var(--font-mono)' }}>{selectedInfo.name}</strong>
                        {selectedTableMetrics?.description && (
                          <div className={styles.selectionNote}>
                            {selectedTableMetrics.description}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {Object.keys(selectedTableMetrics?.fields || {}).length > 0 && (
                          <span className={styles.selectionMetricCount}>
                            {Object.keys(selectedTableMetrics?.fields || {}).length} 项指标
                          </span>
                        )}
                        <span className={styles.selectionBadge}>TABLE</span>
                      </div>
                    </div>
                    <div className={styles.selectionMeta}>
                      {(selectedInfo.columns || []).length} 个字段
                    </div>

                    {(selectedInfo.columns || []).length === 0 ? (
                      <div className={styles.selectionEmpty}>当前表结构没有字段信息。</div>
                    ) : (
                      <div className={styles.selectionFields}>
                        {(selectedInfo.columns || []).map((column) => {
                          const fieldMetric = selectedTableMetrics?.fields?.[column.name];
                          return (
                            <div key={column.name} className={styles.selectionFieldCard}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <strong style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{column.name}</strong>
                                  {fieldMetric && (
                                    <MetricBadge
                                      label={fieldMetric.metricName || '已配指标'}
                                      tooltip={buildMetricTooltip(fieldMetric, `${selectedInfo.name}.${column.name}`)}
                                    />
                                  )}
                                </div>
                                <span style={{ fontSize: 10, color: 'var(--color-text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>
                                  {column.type}
                                </span>
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 10, color: 'var(--color-text-muted)' }}>
                                {column.isPrimary && <span>主键</span>}
                                {column.nullable === false && <span>非空</span>}
                                {column.defaultValue && <span>默认值: {column.defaultValue}</span>}
                                {column.extra && <span>{column.extra}</span>}
                              </div>
                              {fieldMetric?.description && (
                                <div className={styles.selectionMetricHint}>{fieldMetric.description}</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className={styles.sqlPanel}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <strong style={{ fontSize: 15 }}>SQL 编写区</strong>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                      使用 <code>{'{{variable}}'}</code> 占位；也可以让 AI 结合字段指标与表说明，直接把自然语言需求改写成 SQL。
                    </div>
                  </div>
                  <div className={styles.sqlHeaderActions}>
                    {activeModel && (
                      <span className={styles.modelStatusBadge} title={getModelOptionLabel(activeModel)}>
                        {activeModel.modelId}
                      </span>
                    )}
                    <button className={styles.aiChatTrigger} type="button" onClick={() => void openChatPanel()}>
                      <Icons.MessageSquare size={15} />
                      AI Chat
                    </button>
                    <button className={styles.sqlUtilityBtn} type="button" onClick={handleBeautifySql}>
                      <Icons.Code size={15} />
                      美化 SQL
                    </button>
                    <button className={styles.sqlRunBtn} type="button" onClick={handleRun} disabled={isRunning}>
                      <Icons.Zap size={15} />
                      {isRunning ? '执行中...' : '运行预览'}
                    </button>
                  </div>
                </div>

                <textarea
                  className={`form-input ${styles.editorArea}`}
                  value={sqlDraft}
                  onChange={(event) => setSqlDraft(event.target.value)}
                  placeholder={'SELECT *\nFROM "your_table"\nWHERE id = {{id}}\nLIMIT 10;'}
                />

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {sqlVariables.length > 0 ? (
                    sqlVariables.map((variableKey) => (
                      <span
                        key={variableKey}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 999,
                          background: 'var(--color-bg-subtle)',
                          border: '1px solid var(--color-border)',
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {`{{${variableKey}}}`}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      暂未识别到 SQL 变量。
                    </span>
                  )}
                </div>

                {sqlVariables.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>运行预览参数</div>
                    <div className={styles.paramGrid}>
                      {sqlVariables.map((variableKey) => (
                        <div key={variableKey} className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">{variableKey}</label>
                          <input
                            className="form-input"
                            style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                            value={runParams[variableKey] || ''}
                            onChange={(event) =>
                              setRunParams((current) => ({
                                ...current,
                                [variableKey]: event.target.value,
                              }))
                            }
                            placeholder={`输入 ${variableKey}`}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>

          <div className={styles.results} ref={resultsRef}>
            <div className={styles.resultsHeader}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <strong style={{ fontSize: 15 }}>SQL 运行预览</strong>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  基于当前草稿直接联调数据库，并按预览上限返回结果集。
                </span>
              </div>
              {result && (
                <span className={`method-badge ${result.error ? 'method-delete' : 'method-get'}`} style={{ transform: 'scale(0.9)', transformOrigin: 'right' }}>
                  {result.error ? 'ERROR' : 'OK'}
                </span>
              )}
            </div>
            <div className={styles.resultsBody}>
              <PreviewResultPanel payload={result} />
            </div>
          </div>
        </div>
      </div>

      {chatOpen && (
        <div
          className={styles.chatPanelOverlay}
          onClick={() => {
            setChatOpen(false);
            setModelPickerOpen(false);
          }}
        >
          <div className={styles.chatPanel} onClick={(event) => event.stopPropagation()}>
            <div className={styles.chatPanelHeader}>
              <div>
                <div className={styles.chatPanelTitle}>
                  <Icons.Sparkles size={16} />
                  SQL AI Chat
                </div>
                <div className={styles.chatPanelDesc}>
                  基于当前数据库表结构、字段指标、整表说明与 SQL 草稿，把自然语言需求直接转换成可运行 SQL。
                </div>
              </div>
              <div className={styles.chatHeaderActions}>
                <button
                  className={styles.chatGhostBtn}
                  type="button"
                  onClick={() => setDebugOpen((current) => !current)}
                >
                  <Icons.Code size={14} />
                  {debugOpen ? '收起 Debug' : 'Prompt Debug'}
                </button>
                <div
                  className={styles.chatModelPicker}
                  ref={modelPickerRef}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <button
                    className={styles.chatModelBtn}
                    type="button"
                    onClick={() => setModelPickerOpen((current) => !current)}
                    aria-expanded={modelPickerOpen}
                    aria-haspopup="menu"
                    disabled={modelOptions.length === 0}
                    title={activeModel ? getModelOptionLabel(activeModel) : '选择模型'}
                  >
                    <Icons.Sparkles size={14} />
                    <span>{activeModel ? getModelOptionLabel(activeModel) : (modelLoading ? '读取模型中...' : '选择模型')}</span>
                  </button>
                  {modelPickerOpen && (
                    <div className={styles.chatModelMenu} role="menu">
                      <div className={styles.chatModelMenuHeader}>
                        <span>切换 AI 模型</span>
                        <button
                          type="button"
                          className={styles.chatModelRefreshBtn}
                          onClick={() => void loadModelProfiles()}
                        >
                          <Icons.Refresh size={12} />
                        </button>
                      </div>
                      {modelOptions.length > 0 ? modelOptions.map((option) => {
                        const optionKey = getAIModelSelectionKey(option);
                        const isActive = activeModelKey === optionKey || (!activeModelKey && option.isDefault);
                        return (
                          <button
                            key={optionKey}
                            type="button"
                            className={`${styles.chatModelOption} ${isActive ? styles.active : ''}`}
                            onClick={() => {
                              setActiveModelKey(optionKey);
                              setModelPickerOpen(false);
                            }}
                          >
                            <div>{option.profileName}</div>
                            <strong>{option.modelId}</strong>
                            {option.isDefault && <span>默认</span>}
                          </button>
                        );
                      }) : (
                        <div className={styles.chatModelEmpty}>还没有可用模型，请先去模型管理创建配置。</div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  className={styles.chatCloseBtn}
                  type="button"
                  onClick={() => {
                    setChatOpen(false);
                    setModelPickerOpen(false);
                  }}
                  title="关闭 AI Chat"
                >
                  <Icons.X size={18} />
                </button>
              </div>
            </div>

            <div className={styles.chatPanelBody}>
              <div className={styles.chatMainColumn}>
                <div className={styles.chatContextBar}>
                  <span>{tableCollections.length} 张表</span>
                  <span>{sqlVariables.length} 个 SQL 变量</span>
                  <span>{Object.keys(selectedTableMetrics?.fields || {}).length} 项当前表指标</span>
                  <span>{activeModel ? `当前模型 ${activeModel.modelId}` : '未选择模型'}</span>
                </div>

                <div className={styles.chatSuggestionRow}>
                  {AI_SQL_SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      className={styles.chatSuggestionBtn}
                      type="button"
                      onClick={() => void sendChatMessage(suggestion)}
                      disabled={chatLoading}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>

                <div className={styles.chatMessages} ref={chatMessagesRef}>
                  {chatMessages.map((message) => (
                    <div
                      key={message.id}
                      className={`${styles.chatMessage} ${message.role === 'user' ? styles.user : styles.assistant} ${message.error ? styles.error : ''}`}
                    >
                      <div className={styles.chatMessageRole}>{message.role === 'user' ? '你' : 'AI'}</div>
                      <div className={styles.chatMessageBubble}>
                        {message.content}
                        {message.sql && (
                          <div className={styles.chatSqlCard}>
                            <div className={styles.chatSqlCardHeader}>
                              <strong>实际 SQL</strong>
                              {message.variables && message.variables.length > 0 ? (
                                <span>识别 {message.variables.length} 个变量</span>
                              ) : (
                                <span>可直接回填到编辑区</span>
                              )}
                            </div>
                            <pre className={styles.chatSqlCode}>{message.sql}</pre>
                            {message.variables && message.variables.length > 0 && (
                              <div className={styles.chatVariableRow}>
                                {message.variables.map((variableKey) => (
                                  <span key={`${message.id}-${variableKey}`} className={styles.chatVariableTag}>
                                    {`{{${variableKey}}}`}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className={`${styles.chatMessage} ${styles.assistant}`}>
                      <div className={styles.chatMessageRole}>AI</div>
                      <div className={styles.chatMessageBubble}>正在生成 SQL，并准备把结果自动回填到编写区...</div>
                    </div>
                  )}
                </div>

                <div className={styles.chatComposer}>
                  <textarea
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault();
                        void sendChatMessage();
                      }
                    }}
                    className={styles.chatTextarea}
                    placeholder="例如：按用户最近 7 天活跃次数统计，返回 user_id、活跃天数、最后活跃时间，并预留 {{tenantId}} 条件。"
                  />
                  <div className={styles.chatComposerFooter}>
                    <span className={styles.chatComposerHint}>Ctrl/Command + Enter 发送，并自动应用到 SQL 编写区</span>
                    <div className={styles.chatComposerActions}>
                      <button
                        className={styles.chatSendBtn}
                        type="button"
                        onClick={() => void sendChatMessage()}
                        disabled={chatLoading || !chatInput.trim()}
                      >
                        <Icons.Send size={14} />
                        {chatLoading ? '生成中...' : '发送并应用'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <aside className={styles.chatSideColumn}>
                {latestGeneratedSql && (
                  <div className={styles.chatLatestSqlCard}>
                    <div className={styles.chatLatestSqlHeader}>
                      <div>
                        <strong>最近一次生成的 SQL</strong>
                        <span>{sqlVariables.length > 0 ? `${sqlVariables.length} 个变量已同步识别` : '可直接继续调整后运行预览'}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.chatCollapseBtn}
                        onClick={() => setLatestSqlExpanded((current) => !current)}
                      >
                        <Icons.ChevronRight
                          size={14}
                          style={{ transform: latestSqlExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                        />
                        {latestSqlExpanded ? '收起' : '展开'}
                      </button>
                    </div>
                    {latestSqlExpanded && (
                      <div className={styles.chatLatestSqlBody}>
                        <pre className={styles.chatSqlCode}>{latestGeneratedSql}</pre>
                      </div>
                    )}
                  </div>
                )}

                {debugOpen && (
                  <div className={styles.chatDebugPanel}>
                    <div className={styles.chatDebugHeader}>
                      <div>
                        <strong className={styles.chatDebugTitle}>本次生成 Prompt</strong>
                        <div className={styles.chatDebugDesc}>
                          这里展示压缩后的模型上下文，可直接编辑后再次生成 SQL。
                        </div>
                      </div>
                      <div className={styles.chatComposerActions}>
                        <button
                          type="button"
                          className={styles.chatGhostBtn}
                          onClick={() => setPromptDraft(lastResolvedPrompt)}
                          disabled={!lastResolvedPrompt || promptDraft === lastResolvedPrompt}
                        >
                          <Icons.Refresh size={14} />
                          恢复原始 Prompt
                        </button>
                        <button
                          type="button"
                          className={styles.chatSendBtn}
                          onClick={() => void handleRegenerateWithPrompt()}
                          disabled={chatLoading || !(promptDraft.trim() || lastResolvedPrompt)}
                        >
                          <Icons.Send size={14} />
                          {chatLoading ? '生成中...' : '用当前 Prompt 再生成'}
                        </button>
                      </div>
                    </div>
                    <div className={styles.chatDebugMeta}>
                      当前需求：{chatInput.trim() || latestUserInstruction || '尚未发送指令'}
                    </div>
                    <div className={styles.chatDebugTextareaWrap}>
                      <textarea
                        className={styles.chatDebugTextarea}
                        value={promptDraft}
                        onChange={(event) => setPromptDraft(event.target.value)}
                        placeholder="先生成一次 SQL，这里会展示本次 NL2SQL 的完整 Prompt。"
                      />
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </div>
        </div>
      )}

      {modelReminderOpen && (
        <div className={styles.chatPanelOverlay} onClick={() => setModelReminderOpen(false)}>
          <div className={styles.modelReminderCard} onClick={(event) => event.stopPropagation()}>
            <div className={styles.modelReminderIcon}>
              <Icons.Sparkles size={22} />
            </div>
            <div className={styles.modelReminderTitle}>请先配置 AI 模型</div>
            <div className={styles.modelReminderDesc}>
              SQL AI Chat 需要从“模型管理”里读取 OpenAI 兼容模型配置。请至少添加一个模型来源，并设置可用的 Model ID。
            </div>
            <div className={styles.modelReminderActions}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setModelReminderOpen(false)}
              >
                稍后再说
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => unsavedGuard.confirmAction(() => router.push('/model-management'))}
              >
                <Icons.ExternalLink size={14} />
                前往模型管理
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            padding: '12px 16px',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--color-border)',
            background: toast.type === 'success' ? 'white' : 'var(--color-danger-soft)',
            color: toast.type === 'success' ? 'var(--color-text)' : 'var(--color-danger)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 1000,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {toast.message}
        </div>
      )}

      <UnsavedChangesDialog
        open={unsavedGuard.dialogOpen}
        saving={unsavedGuard.saving}
        onCancel={unsavedGuard.closeDialog}
        onDiscard={() => void unsavedGuard.handleDiscard()}
        onSaveAndContinue={() => void unsavedGuard.handleSaveAndContinue()}
      />
    </div>
  );
}

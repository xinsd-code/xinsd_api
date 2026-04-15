'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '@/components/Icons';
import { flattenAIModelSelections, getAIModelSelectionKey, getDefaultAIModelSelection } from '@/lib/ai-models';
import { formatSqlDraft } from '@/lib/sql-format';
import { AIModelProfile, DatabaseInstanceSummary } from '@/lib/types';
import styles from './page.module.css';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  sql?: string;
  summary?: string;
  rows?: number;
  followUps?: string[];
  error?: boolean;
}

interface ExecutionPayload {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  summary?: string;
  datasource: string;
  engine: 'mysql' | 'pgsql' | 'mongo';
  previewSql: string;
}

interface AgentResponse {
  message: string;
  sql: string;
  execution?: ExecutionPayload;
  prompt: string;
}

interface SessionSnapshot {
  id: string;
  timestamp: string;
  question: string;
  title: string;
  trigger: 'ai' | 'manual';
  sql: string;
  summary?: string;
  datasource: string;
  engine: 'mysql' | 'pgsql' | 'mongo';
  columns: string[];
  rows: Record<string, unknown>[];
  prompt?: string;
}

function createMessageId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function generateFollowUpSuggestions(result: ExecutionPayload | null, sql: string): string[] {
  if (!result) {
    return [
      '把结果限制到最近 20 条',
      '按时间倒序重排结果',
      '只保留最关键的字段',
    ];
  }

  const firstColumns = result.columns.slice(0, 3);
  const suggestions = [
    result.columns[0] ? `只看 ${result.columns[0]} 相关的数据，并限制 20 条` : '',
    firstColumns.length >= 2 ? `按 ${firstColumns[0]} 分组，并统计 ${firstColumns[1]} 的数量` : '',
    '把范围缩小到最近 7 天',
    '帮我基于当前结果补充排序并过滤异常值',
    sql ? '在当前查询基础上继续优化字段和筛选条件' : '',
  ].filter(Boolean);

  return Array.from(new Set(suggestions)).slice(0, 4);
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(value: unknown): string {
  const text = stringifyCell(value).replace(/\r?\n/g, ' ');
  if (/[",]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(result: ExecutionPayload): string {
  const header = result.columns.map((column) => escapeCsvCell(column)).join(',');
  const rows = result.rows.map((row) => result.columns.map((column) => escapeCsvCell(row[column])).join(','));
  return [header, ...rows].join('\n');
}

function buildHistoryTitle(mode: 'ai' | 'manual', sql: string, messages: ChatMessage[]): string {
  const latestUser = [...messages].reverse().find((item) => item.role === 'user')?.content || '';
  if (latestUser.trim()) {
    return latestUser.slice(0, 80);
  }
  if (mode === 'manual') {
    return '手动执行查询';
  }
  return 'AI 取数';
}

function Nl2DataPageContent() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: createMessageId(),
      role: 'assistant',
      content: '描述你想要的数据，我会结合当前数据源生成只读查询，并把结果直接同步到下方工作区。',
    },
  ]);
  const [composer, setComposer] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [executeLoading, setExecuteLoading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDebug, setPromptDebug] = useState('');
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [currentSql, setCurrentSql] = useState('');
  const [result, setResult] = useState<ExecutionPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [sessionHistory, setSessionHistory] = useState<SessionSnapshot[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<SessionSnapshot | null>(null);

  const [databaseInstances, setDatabaseInstances] = useState<DatabaseInstanceSummary[]>([]);
  const [modelProfiles, setModelProfiles] = useState<AIModelProfile[]>([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState('');
  const [selectedModelKey, setSelectedModelKey] = useState('');

  const messageViewportRef = useRef<HTMLDivElement | null>(null);

  const sqlDatabaseInstances = useMemo(
    () => databaseInstances.filter((item) => item.type === 'mysql' || item.type === 'pgsql' || item.type === 'mongo'),
    [databaseInstances]
  );
  const modelSelections = useMemo(() => flattenAIModelSelections(modelProfiles, 'chat'), [modelProfiles]);
  const selectedModel = useMemo(
    () => modelSelections.find((item) => getAIModelSelectionKey(item) === selectedModelKey) || null,
    [modelSelections, selectedModelKey]
  );
  const selectedDatabase = useMemo(
    () => sqlDatabaseInstances.find((item) => item.id === selectedDatabaseId) || null,
    [selectedDatabaseId, sqlDatabaseInstances]
  );
  const followUpSuggestions = useMemo(() => generateFollowUpSuggestions(result, currentSql), [currentSql, result]);

  const hasDatasource = sqlDatabaseInstances.length > 0;
  const hasModel = modelSelections.length > 0;
  const canSend = hasDatasource && hasModel && !!composer.trim() && !chatLoading;
  const canExecuteSql = hasDatasource && !!selectedDatabaseId && !!currentSql.trim() && !executeLoading;

  const fetchDependencies = useCallback(async () => {
    try {
      const [databaseRes, modelRes] = await Promise.all([
        fetch('/api/database-instances'),
        fetch('/api/ai-models'),
      ]);

      if (databaseRes.ok) {
        const data = await databaseRes.json() as DatabaseInstanceSummary[];
        setDatabaseInstances(Array.isArray(data) ? data : []);
      }

      if (modelRes.ok) {
        const data = await modelRes.json() as AIModelProfile[];
        setModelProfiles(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error('Failed to fetch NL2DATA dependencies:', error);
    }
  }, []);

  const fetchSessionHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/nl2data/history', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('读取会话历史失败');
      }

      const data = await response.json() as SessionSnapshot[];
      setSessionHistory(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch NL2DATA history:', error);
    }
  }, []);

  useEffect(() => {
    void fetchDependencies();
    void fetchSessionHistory();
  }, [fetchDependencies, fetchSessionHistory]);

  useEffect(() => {
    if (!sqlDatabaseInstances.length) {
      setSelectedDatabaseId('');
      return;
    }

    setSelectedDatabaseId((current) => (
      current && sqlDatabaseInstances.some((item) => item.id === current) ? current : sqlDatabaseInstances[0].id
    ));
  }, [sqlDatabaseInstances]);

  useEffect(() => {
    if (!modelSelections.length) {
      setSelectedModelKey('');
      return;
    }

    const defaultSelection = getDefaultAIModelSelection(modelProfiles, 'chat');
    const defaultKey = defaultSelection ? getAIModelSelectionKey(defaultSelection) : getAIModelSelectionKey(modelSelections[0]);

    setSelectedModelKey((current) => (
      current && modelSelections.some((item) => getAIModelSelectionKey(item) === current) ? current : defaultKey
    ));
  }, [modelProfiles, modelSelections]);

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport || !chatOpen) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  }, [chatLoading, chatOpen, messages, promptOpen]);

  const appendAssistantError = useCallback((message: string) => {
    setMessages((current) => [
      ...current,
      {
        id: createMessageId(),
        role: 'assistant',
        content: message,
        error: true,
      },
    ]);
  }, []);

  const appendHistory = useCallback(async (mode: 'ai' | 'manual', execution: ExecutionPayload, prompt?: string, question?: string) => {
    const nextQuestion = (question || currentQuestion || [...messages].reverse().find((item) => item.role === 'user')?.content || '').trim();
    const snapshot: SessionSnapshot = {
      id: createMessageId(),
      timestamp: new Date().toISOString(),
      question: nextQuestion,
      title: nextQuestion || buildHistoryTitle(mode, execution.sql, messages),
      trigger: mode,
      sql: execution.sql,
      summary: execution.summary,
      datasource: execution.datasource,
      engine: execution.engine,
      columns: execution.columns,
      rows: execution.rows,
      prompt,
    };

    const response = await fetch('/api/nl2data/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(snapshot),
    });

    if (!response.ok) {
      throw new Error('保存会话历史失败');
    }

    const created = await response.json() as SessionSnapshot;
    setSessionHistory((current) => [created, ...current.filter((item) => item.id !== created.id)].slice(0, 24));
  }, [currentQuestion, messages]);

  const runAgent = useCallback(async () => {
    const content = composer.trim();
    if (!content || !selectedDatabaseId || !selectedModel) return;

    const nextUserMessage: ChatMessage = {
      id: createMessageId(),
      role: 'user',
      content,
    };

    const historyForRequest = [
      ...messages.map((item) => ({ role: item.role, content: item.content })),
      { role: 'user' as const, content },
    ];

    setMessages((current) => [...current, nextUserMessage]);
    setComposer('');
    setCurrentQuestion(content);
    setChatLoading(true);
    setErrorMessage('');
    if (!chatOpen) setChatOpen(true);

    try {
      const response = await fetch('/api/nl2data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: historyForRequest,
          currentSql,
          currentResult: result ? {
            columns: result.columns,
            rows: result.rows,
            summary: result.summary,
          } : null,
          databaseInstanceId: selectedDatabaseId,
          selectedModel: {
            profileId: selectedModel.profileId,
            modelId: selectedModel.modelId,
          },
        }),
      });

      const payload = await response.json() as AgentResponse | { error?: string };
      if (!response.ok) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : 'NL2DATA 执行失败');
      }

      if (!('execution' in payload) || !payload.execution) {
        throw new Error('NL2DATA 执行失败');
      }

      const execution = payload.execution;
      if (!execution) {
        throw new Error('NL2DATA 执行失败');
      }

      setCurrentSql(payload.sql);
      setPromptDebug(payload.prompt);
      setResult(execution);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: 'assistant',
          content: payload.message,
          sql: payload.sql,
          summary: execution.summary,
          rows: execution.rows.length,
          followUps: generateFollowUpSuggestions(execution, payload.sql),
        },
      ]);
      await appendHistory('ai', execution, payload.prompt, content);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'NL2DATA 执行失败';
      setErrorMessage(message);
      appendAssistantError(message);
    } finally {
      setChatLoading(false);
    }
  }, [appendAssistantError, appendHistory, chatOpen, composer, currentSql, messages, result, selectedDatabaseId, selectedModel]);

  const executeCurrentSql = useCallback(async () => {
    if (!selectedDatabaseId || !currentSql.trim()) return;

    setExecuteLoading(true);
    setErrorMessage('');

    try {
      const response = await fetch('/api/nl2data/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          databaseInstanceId: selectedDatabaseId,
          sql: currentSql,
        }),
      });

      const payload = await response.json() as ExecutionPayload | { error?: string };

      if (!response.ok || !('columns' in payload)) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : '查询执行失败');
      }

      setResult(payload);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '查询执行失败');
    } finally {
      setExecuteLoading(false);
    }
  }, [currentSql, selectedDatabaseId]);

  const handleComposerKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (canSend) {
        void runAgent();
      }
    }
  }, [canSend, runAgent]);

  const handleSuggestionClick = useCallback((suggestion: string) => {
    setComposer(suggestion);
    if (!chatOpen) setChatOpen(true);
  }, [chatOpen]);

  const handleExportJson = useCallback(() => {
    if (!result) return;
    downloadTextFile(`nl2data-${Date.now()}.json`, JSON.stringify(result.rows, null, 2), 'application/json;charset=utf-8');
  }, [result]);

  const handleExportCsv = useCallback(() => {
    if (!result) return;
    downloadTextFile(`nl2data-${Date.now()}.csv`, buildCsv(result), 'text/csv;charset=utf-8');
  }, [result]);

  const handleRestoreSnapshot = useCallback((snapshot: SessionSnapshot) => {
    setCurrentQuestion(snapshot.question || snapshot.title || '');
    setCurrentSql(snapshot.sql);
    setPromptDebug(snapshot.prompt || '');
    setResult({
      sql: snapshot.sql,
      columns: snapshot.columns,
      rows: snapshot.rows,
      summary: snapshot.summary,
      datasource: snapshot.datasource,
      engine: snapshot.engine,
      previewSql: snapshot.sql,
    });
  }, []);

  const handleBeautifySql = useCallback(() => {
    setCurrentSql((current) => formatSqlDraft(current));
  }, []);

  const handleDeleteHistory = useCallback((snapshotId: string) => {
    void (async () => {
      try {
        const response = await fetch(`/api/nl2data/history/${snapshotId}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          throw new Error('删除会话历史失败');
        }
        setSessionHistory((current) => current.filter((item) => item.id !== snapshotId));
        if (selectedHistory?.id === snapshotId) {
          setSelectedHistory(null);
        }
      } catch (error) {
        console.error('Failed to delete NL2DATA history:', error);
      }
    })();
  }, [selectedHistory]);

  const handleSyncHistory = useCallback((snapshot: SessionSnapshot) => {
    handleRestoreSnapshot(snapshot);
    setSelectedHistory(null);
  }, [handleRestoreSnapshot]);

  return (
    <div className={styles.workspace}>
      <section className={styles.heroCard}>
        <div className={styles.heroTitleWrap}>
          <div className={styles.eyebrow}>Natural Language To Data</div>
          <div className={styles.title}>NL2DATA 控制台</div>
          <div className={styles.desc}>
            让对话、查询和数据结果保持同一条研究轨迹。上层用于发问、追问和查看 Prompt，下层用于落地查询、比对结果与回看历史。
          </div>
        </div>
        <div className={styles.heroActions}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setChatOpen((current) => !current)}
          >
            <Icons.MessageSquare size={16} />
            {chatOpen ? '关闭 AI Chat' : 'AI Chat'}
          </button>
        </div>
      </section>

      <section className={styles.controlCard}>
        <div className={styles.controlGrid}>
          <div>
            <div className={styles.selectorLabel}>
              <span>数据源</span>
              <span className={styles.selectorHint}>当前支持 MySQL / PostgreSQL / MongoDB</span>
            </div>
            <select
              className="form-select"
              name="nl2data-datasource"
              value={selectedDatabaseId}
              onChange={(event) => setSelectedDatabaseId(event.target.value)}
              disabled={!hasDatasource}
            >
              {!hasDatasource && <option value="">暂无可用数据源</option>}
              {sqlDatabaseInstances.map((item) => (
                <option key={item.id} value={item.id}>
                  [{item.type.toUpperCase()}] {item.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className={styles.selectorLabel}>
              <span>模型</span>
              <span className={styles.selectorHint}>使用已接入模型</span>
            </div>
            <select
              className="form-select"
              name="nl2data-model"
              value={selectedModelKey}
              onChange={(event) => setSelectedModelKey(event.target.value)}
              disabled={!hasModel}
            >
              {!hasModel && <option value="">暂无可用模型</option>}
              {modelSelections.map((item) => {
                const key = getAIModelSelectionKey(item);
                return (
                  <option key={key} value={key}>
                    {item.profileName} / {item.modelId}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        {!hasDatasource && (
          <div className={styles.inlineNotice}>
            <div className={styles.inlineNoticeTitle}>
              <Icons.Database size={16} />
              先新增可用数据源
            </div>
            <div className={styles.inlineNoticeText}>
              当前没有可用的数据源。NL2DATA 本次支持 MySQL、PostgreSQL 和 MongoDB，Redis 入口已预留，后续可直接扩展。
            </div>
            <div className={styles.inlineNoticeActions}>
              <Link href="/database-instances" className="btn btn-secondary btn-sm">
                前往新增数据源
              </Link>
            </div>
          </div>
        )}

        {!hasModel && (
          <div className={styles.inlineNotice}>
            <div className={styles.inlineNoticeTitle}>
              <Icons.Sparkles size={16} />
              先新增模型
            </div>
            <div className={styles.inlineNoticeText}>
              当前没有可用模型，无法把自然语言转成 SQL。请先去模型管理配置至少一个 OpenAI Compatible 模型。
            </div>
            <div className={styles.inlineNoticeActions}>
              <Link href="/model-management" className="btn btn-secondary btn-sm">
                前往新增模型
              </Link>
            </div>
          </div>
        )}
      </section>

      <section className={`${styles.researchStage} ${chatOpen ? styles.researchStageOpen : styles.researchStageCollapsed}`} />

      {chatOpen && (
        <div
          className={styles.chatPanelOverlay}
          onClick={() => setChatOpen(false)}
        >
          <div className={styles.chatPanel} onClick={(event) => event.stopPropagation()}>
            <div className={styles.chatPanelHeader}>
              <div>
                <div className={styles.chatPanelTitle}>
                  <Icons.MessageSquare size={16} />
                  AI Chat
                </div>
                <div className={styles.chatPanelDesc}>
                  基于当前数据源、模型、已有查询和结果上下文，把自然语言需求持续转成可验证的取数查询。
                </div>
              </div>
              <div className={styles.chatHeaderActions}>
                <button
                  type="button"
                  className={styles.chatGhostBtn}
                  onClick={() => setPromptOpen((current) => !current)}
                  disabled={!promptDebug}
                >
                  <Icons.Code size={14} />
                  {promptOpen ? '收起 Prompt' : '查看Prompt'}
                </button>
                <button
                  type="button"
                  className={styles.chatCloseBtn}
                  onClick={() => setChatOpen(false)}
                  title="关闭 AI Chat"
                >
                  <Icons.X size={18} />
                </button>
              </div>
            </div>

            <div className={styles.chatPanelBody}>
              <div className={styles.chatMainColumn}>
                <div className={styles.chatContextBar}>
                  <span>{selectedDatabase ? selectedDatabase.name : '未选择数据源'}</span>
                  <span>{selectedModel ? selectedModel.modelId : '未选择模型'}</span>
                  <span>{currentSql.trim() ? '已有查询草稿' : '等待首次生成查询'}</span>
                  <span>{result ? `${result.rows.length} 行当前结果` : '暂无结果集'}</span>
                </div>

                <div className={styles.chatMessages} ref={messageViewportRef}>
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`${styles.chatMessage} ${message.role === 'user' ? styles.user : styles.assistant} ${message.error ? styles.error : ''}`}
                    >
                      <div className={styles.chatMessageRole}>{message.role === 'user' ? '你' : 'AI'}</div>
                      <div className={styles.chatMessageBubble}>
                        {message.content}
                        {(message.sql || message.summary) && (
                          <div className={styles.chatSqlCard}>
                            <div className={styles.chatSqlCardHeader}>
                              <strong>当前结果同步</strong>
                              {message.sql ? <span>查询已更新</span> : <span>仅同步结果摘要</span>}
                            </div>
                            {message.sql && <pre className={styles.chatSqlCode}>{message.sql}</pre>}
                            {message.summary && (
                              <div className={styles.messageMetaRow}>
                                <span>{message.summary}</span>
                                {typeof message.rows === 'number' && <span className={styles.metaChip}>{message.rows} rows</span>}
                              </div>
                            )}
                            {message.followUps && message.followUps.length > 0 && (
                              <div className={styles.suggestionRow}>
                                {message.followUps.map((suggestion) => (
                                  <button
                                    key={`${message.id}-${suggestion}`}
                                    type="button"
                                    className={styles.chatSuggestionBtn}
                                    onClick={() => handleSuggestionClick(suggestion)}
                                  >
                                    {suggestion}
                                  </button>
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
                      <div className={styles.chatMessageBubble}>正在识别业务名词、补充字段语义并生成查询...</div>
                    </div>
                  )}
                </div>

                <div className={styles.chatComposer}>
                  <textarea
                    className={styles.chatTextarea}
                    name="nl2data-composer"
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    disabled={!hasDatasource || !hasModel || chatLoading}
                    placeholder={
                      hasDatasource && hasModel
                        ? '例如：帮我查最近 7 天成交金额最高的 20 个订单，并带上用户名称'
                        : '请先配置可用数据源与模型'
                    }
                  />
                  <div className={styles.chatComposerFooter}>
                    <span className={styles.chatComposerHint}>Ctrl / Command + Enter 发送，并自动同步到下层查询工作区</span>
                    <div className={styles.chatComposerActions}>
                      <button
                        type="button"
                        className={styles.chatGhostBtn}
                        onClick={() => {
                          setComposer('');
                          setErrorMessage('');
                        }}
                        disabled={chatLoading || !composer}
                      >
                        清空输入
                      </button>
                      <button
                        type="button"
                        className={styles.chatSendBtn}
                        onClick={() => void runAgent()}
                        disabled={!canSend}
                      >
                        <Icons.Send size={14} />
                        {chatLoading ? '处理中...' : '发送取数'}
                      </button>
                    </div>
                  </div>
                  <div className={styles.chatSuggestionRow}>
                    {followUpSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className={styles.chatSuggestionBtn}
                        onClick={() => handleSuggestionClick(suggestion)}
                        disabled={chatLoading}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <aside className={styles.chatSideColumn}>
                {currentSql.trim() && (
                  <div className={styles.chatLatestSqlCard}>
                    <div className={styles.chatLatestSqlHeader}>
                      <div>
                        <strong>最近一次生成的查询</strong>
                        <span>{result ? '可直接继续调整后重新执行' : '等待执行结果返回'}</span>
                      </div>
                    </div>
                    <div className={styles.chatLatestSqlBody}>
                      <pre className={styles.chatSqlCode}>{currentSql}</pre>
                    </div>
                  </div>
                )}

                {promptOpen && promptDebug && (
                  <div className={styles.chatDebugPanel}>
                    <div className={styles.chatDebugHeader}>
                      <div>
                        <strong className={styles.chatDebugTitle}>本次生成 Prompt</strong>
                        <div className={styles.chatDebugDesc}>
                          这里展示当前 NL2DATA 的两阶段上下文，包含第一轮 NER 和第二轮查询生成内容，便于排查与校验。
                        </div>
                      </div>
                    </div>
                    <div className={styles.chatDebugTextareaWrap}>
                      <pre className={styles.promptCode}>{promptDebug}</pre>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </div>
        </div>
      )}

      <section className={styles.contentPanel}>
        <div className={styles.workbenchRow}>
          <div className={styles.sqlCard}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>
                <div className={styles.eyebrow}>Generated SQL</div>
                <div className={styles.sectionName}>取数查询</div>
              </div>
              <div className={styles.toolbar}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleBeautifySql}
                  disabled={!currentSql}
                >
                  <Icons.Code size={16} />
                  美化查询
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setCurrentSql('');
                    setPromptDebug('');
                  }}
                  disabled={!currentSql}
                >
                    清空查询
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void executeCurrentSql()}
                  disabled={!canExecuteSql}
                >
                  <Icons.Activity size={16} />
                  {executeLoading ? '执行中...' : '重新执行'}
                </button>
              </div>
            </div>

            <div className={styles.sqlBody}>
              <div className={styles.questionPanel}>
                <div className={styles.questionLabel}>用户问句</div>
                <div className={styles.questionText}>
                  {currentQuestion.trim() || '当前还没有关联问句。你可以从 AI Chat 发起取数，或者从会话历史同步一组问句与查询。'}
                </div>
              </div>
              <textarea
                className={styles.sqlEditor}
                name="nl2data-sql"
                value={currentSql}
                onChange={(event) => setCurrentSql(event.target.value)}
                placeholder="这里仅存放最终查询。发送自然语言后，AI 生成的查询会回填到这里。"
              />
            </div>
          </div>

          <aside className={styles.historyPanel}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>
                <div className={styles.eyebrow}>Session Timeline</div>
                <div className={styles.sectionName}>会话历史</div>
              </div>
            </div>

            <div className={styles.historyPanelBody}>
              <div className={styles.selectorHint}>最近 {sessionHistory.length} 次</div>
              {sessionHistory.length === 0 ? (
                <div className={styles.researchEmpty}>当前还没有可回溯的研究记录。</div>
              ) : (
                <div className={styles.historyList}>
                  {sessionHistory.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={styles.historyItem}
                      onClick={() => setSelectedHistory(item)}
                    >
                      <div className={styles.historyRestore}>
                        <div className={styles.historyItemTop}>
                          <strong className={styles.historyTitleText} title={item.question || item.title}>
                            {item.question || item.title}
                          </strong>
                        </div>
                        <div className={styles.historySqlText} title={item.sql}>{item.sql}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>

        <div className={styles.dataCard}>
          <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>
                <div className={styles.eyebrow}>Query Result</div>
                <div className={styles.sectionName}>数据内容</div>
              </div>
              <div className={styles.toolbar}>
                <span className={styles.resultCountTag}>{result ? `${result.rows.length} rows` : '0 rows'}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                onClick={handleExportCsv}
                disabled={!result}
              >
                <Icons.Download size={16} />
                导出 CSV
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleExportJson}
                disabled={!result}
              >
                <Icons.Download size={16} />
                导出 JSON
              </button>
            </div>
          </div>

          <div className={styles.dataBody}>
            {errorMessage && <div className={styles.errorText}>{errorMessage}</div>}

            {!result ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyStateInner}>
                  <Icons.Search size={34} />
                  <div className={styles.emptyStateTitle}>等待第一次查询</div>
                  <div className={styles.emptyStateDesc}>
                    先在上层 AI Chat 发起取数，或者直接在上方查询面板填写只读查询并执行。
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className={styles.tableWrap}>
                  {result.columns.length > 0 ? (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          {result.columns.map((column) => (
                            <th key={column}>{column}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, rowIndex) => (
                          <tr key={`row-${rowIndex}`}>
                            {result.columns.map((column) => (
                              <td key={`${rowIndex}-${column}`}>
                                <div className={styles.cellCode}>{stringifyCell(row[column])}</div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className={styles.emptyState}>
                      <div className={styles.emptyStateInner}>
                        <div className={styles.emptyStateTitle}>当前结果没有可展示数据</div>
                        <div className={styles.emptyStateDesc}>
                          本轮查询已执行成功，但没有返回行。你可以继续追问、调整筛选条件，或者用历史结果做对比。
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {selectedHistory && (
        <div className={styles.historyDetailOverlay} onClick={() => setSelectedHistory(null)}>
          <aside className={styles.historyDetailPanel} onClick={(event) => event.stopPropagation()}>
            <div className={styles.historyDetailHeader}>
              <div>
                <div className={styles.eyebrow}>Session Detail</div>
                <div className={styles.historyDetailTitle}>{selectedHistory.question || selectedHistory.title}</div>
                <div className={styles.historyDetailMeta}>
                  <span>{selectedHistory.trigger === 'ai' ? 'AI' : '手动'}</span>
                  <span>{selectedHistory.datasource}</span>
                  <span>{selectedHistory.rows.length} rows</span>
                  <span>{new Date(selectedHistory.timestamp).toLocaleString('zh-CN')}</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.chatCloseBtn}
                onClick={() => setSelectedHistory(null)}
                title="关闭会话详情"
              >
                <Icons.X size={18} />
              </button>
            </div>

            <div className={styles.historyDetailBody}>
              <div className={styles.historyDetailSection}>
                <div className={styles.historyDetailLabel}>用户问句</div>
                <div className={styles.historyDetailText}>{selectedHistory.question || '该记录没有保存问句。'}</div>
              </div>

              <div className={styles.historyDetailSection}>
                <div className={styles.historyDetailLabel}>查询</div>
                <pre className={styles.historyDetailCode}>{selectedHistory.sql}</pre>
              </div>

              <div className={styles.historyDetailSection}>
                <div className={styles.historyDetailLabel}>Prompt</div>
                <pre className={styles.historyDetailCode}>
                  {selectedHistory.prompt?.trim() || '该记录没有保存 Prompt。'}
                </pre>
              </div>
            </div>

            <div className={styles.historyDetailFooter}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => handleDeleteHistory(selectedHistory.id)}
              >
                <Icons.Trash size={14} />
                删除记录
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleSyncHistory(selectedHistory)}
              >
                <Icons.Activity size={14} />
                同步查询
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

export default function Nl2DataPage() {
  return (
    <Suspense fallback={null}>
      <Nl2DataPageContent />
    </Suspense>
  );
}

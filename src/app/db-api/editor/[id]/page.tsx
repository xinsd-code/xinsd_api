'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '@/components/Icons';
import { readDbApiDraft, writeDbApiDraft } from '@/lib/db-api-draft';
import { extractSqlVariables } from '@/lib/sql-template';
import {
  DatabaseCollectionInfo,
  DatabaseQueryPayload,
  DatabaseSchemaPayload,
  DbApiConfig,
  SqlVariableBinding,
} from '@/lib/types';
import styles from './page.module.css';

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
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [result, setResult] = useState<({ status?: number; error?: string; _meta?: Record<string, unknown> } & Partial<DatabaseQueryPayload>) | null>(null);
  const [previewLimit, setPreviewLimit] = useState('10');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const sqlVariables = useMemo(() => extractSqlVariables(sqlDraft), [sqlDraft]);

  const selectedInfo = useMemo<DatabaseCollectionInfo | null>(
    () => schema?.collections.find((item) => item.name === selectedCollection) || null,
    [schema?.collections, selectedCollection]
  );

  const tableCollections = useMemo(
    () => (schema?.collections || []).filter((item) => item.category === 'table'),
    [schema?.collections]
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
          return;
        }

        const schemaResponse = await fetch(`/api/database-instances/${nextConfig.databaseInstanceId}/schema`);
        const schemaPayload = (await schemaResponse.json()) as DatabaseSchemaPayload | { error?: string };
        if (schemaResponse.ok) {
          const nextSchema = schemaPayload as DatabaseSchemaPayload;
          setSchema(nextSchema);
          setSelectedCollection(nextSchema.collections.find((item) => item.category === 'table')?.name || null);
        } else {
          const schemaError = (schemaPayload as { error?: string }).error;
          setSchema(null);
          showToast(typeof schemaError === 'string' ? schemaError : '读取数据库结构失败', 'error');
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

  const handleRun = async () => {
    if (!config) return;

    setIsRunning(true);
    try {
      const response = await fetch('/api/db-apis/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            ...config,
            sqlTemplate: sqlDraft,
          },
          runParams,
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

  const handleSave = async () => {
    if (!config) return;

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
        return;
      }

      const response = await fetch(`/api/db-apis/${config.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig),
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast(payload.error || '保存 SQL 失败', 'error');
        return;
      }

      setConfig(payload as DbApiConfig);
      showToast('SQL 已保存，返回主配置页即可继续绑定参数');
    } catch (error) {
      console.error(error);
      showToast('保存 SQL 失败', 'error');
    } finally {
      setIsSaving(false);
    }
  };

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
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(backHref)}>
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
              {config.databaseInstanceId || '未选择数据库'}
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
            <button className="btn btn-secondary" onClick={handleRun} disabled={isRunning}>
              <Icons.Zap size={16} />
              {isRunning ? '执行中...' : '运行预览'}
            </button>
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
              filteredCollections.map((collection) => (
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
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    {collection.columns?.length || 0} 个字段
                  </div>
                </div>
              ))
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
                      <strong style={{ fontSize: 14, fontFamily: 'var(--font-mono)' }}>{selectedInfo.name}</strong>
                      <span className={styles.selectionBadge}>TABLE</span>
                    </div>
                    <div className={styles.selectionMeta}>
                      {(selectedInfo.columns || []).length} 个字段
                    </div>

                    {(selectedInfo.columns || []).length === 0 ? (
                      <div className={styles.selectionEmpty}>当前表结构没有字段信息。</div>
                    ) : (
                      <div className={styles.selectionFields}>
                        {(selectedInfo.columns || []).map((column) => (
                          <div key={column.name} className={styles.selectionFieldCard}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                              <strong style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{column.name}</strong>
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
                          </div>
                        ))}
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
                      使用 <code>{'{{variable}}'}</code> 占位，保存草稿后回主配置页即可进行 API 入参绑定。
                    </div>
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
    </div>
  );
}

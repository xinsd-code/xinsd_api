'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog';
import { Icons } from '@/components/Icons';
import {
  CustomParamDef,
  DatabaseInstanceSummary,
  DatabaseQueryPayload,
  DbApiConfig,
  DbApiSummary,
  RedisCacheConfig,
  SqlVariableBinding,
} from '@/lib/types';
import { extractSqlVariables } from '@/lib/sql-template';
import { sanitizeRedisCacheConfig } from '@/lib/redis-cache-config';
import {
  clearDbApiDraft,
  createDbApiDraftKey,
  isDbApiDraftKey,
  readDbApiDraft,
  writeDbApiDraft,
} from '@/lib/db-api-draft';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import styles from '../api-forward/page.module.css';

type ViewMode = 'design' | 'run';
type DebugPayload = ({ status?: number; error?: string; _meta?: Record<string, unknown> } & Partial<DatabaseQueryPayload>) | null;

function normalizeDbApiConfig(config: Partial<DbApiConfig>, fallbackId?: string | null): DbApiConfig {
  const sqlTemplate = config.sqlTemplate || '';
  const sqlVariables = extractSqlVariables(sqlTemplate);

  return {
    id: config.id || fallbackId || 'temp-db-api',
    name: config.name || '',
    apiGroup: config.apiGroup || '未分组',
    description: config.description || '',
    method: config.method || 'GET',
    path: config.path || '',
    customParams: config.customParams || [],
    databaseInstanceId: config.databaseInstanceId || '',
    sqlTemplate,
    paramBindings: (config.paramBindings || []).filter((binding) => sqlVariables.includes(binding.variableKey)),
    redisConfig: sanitizeRedisCacheConfig(config.redisConfig),
    createdAt: config.createdAt || '',
    updatedAt: config.updatedAt || '',
  };
}

function buildDebugDefaults(params: CustomParamDef[]): Record<string, string> {
  return params.reduce<Record<string, string>>((accumulator, item) => {
    accumulator[item.key] = item.defaultValue || '';
    return accumulator;
  }, {});
}

function CustomParamEditor({
  params,
  onChange,
}: {
  params: CustomParamDef[];
  onChange: (params: CustomParamDef[]) => void;
}) {
  const updateField = (index: number, patch: Partial<CustomParamDef>) => {
    const next = [...params];
    next[index] = {
      ...next[index],
      ...patch,
    };
    onChange(next);
  };

  return (
    <div className="card" style={{ padding: 24 }}>
      <div className="section-header" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.Layers size={18} />
          <h3 className="section-title">自定义入参</h3>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onChange([...params, { key: '', type: 'string', description: '', defaultValue: '' }])}
        >
          <Icons.Plus size={14} />
          添加参数
        </button>
      </div>

      {params.length === 0 ? (
        <div
          style={{
            padding: 28,
            textAlign: 'center',
            background: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--color-text-muted)',
            fontSize: 13,
            border: '1px dashed var(--color-border)',
          }}
        >
          先定义 API 入参，稍后可以把它们映射到 SQL 变量或运行调试参数。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {params.map((param, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                padding: 12,
                background: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
              }}
            >
              <input
                className="form-input"
                style={{ flex: 1.3, height: 36 }}
                placeholder="参数名"
                value={param.key}
                onChange={(event) => updateField(index, { key: event.target.value })}
              />
              <select
                className="form-select"
                style={{ width: 120, height: 36 }}
                value={param.type}
                onChange={(event) =>
                  updateField(index, { type: event.target.value as CustomParamDef['type'] })
                }
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="integer">integer</option>
                <option value="boolean">boolean</option>
                <option value="array">array</option>
              </select>
              <input
                className="form-input"
                style={{ flex: 1.2, height: 36 }}
                placeholder="默认值"
                value={param.defaultValue || ''}
                onChange={(event) => updateField(index, { defaultValue: event.target.value })}
              />
              <input
                className="form-input"
                style={{ flex: 1.8, height: 36 }}
                placeholder="描述说明"
                value={param.description || ''}
                onChange={(event) => updateField(index, { description: event.target.value })}
              />
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                style={{ color: 'var(--color-danger)' }}
                onClick={() => onChange(params.filter((_, currentIndex) => currentIndex !== index))}
              >
                <Icons.Trash size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SqlBindingEditor({
  sqlVariables,
  customParams,
  bindings,
  onChange,
}: {
  sqlVariables: string[];
  customParams: CustomParamDef[];
  bindings: SqlVariableBinding[];
  onChange: (bindings: SqlVariableBinding[]) => void;
}) {
  const getBinding = (variableKey: string) => bindings.find((item) => item.variableKey === variableKey);

  const upsertBinding = (variableKey: string, nextBinding: SqlVariableBinding | null) => {
    const next = bindings.filter((item) => item.variableKey !== variableKey);
    onChange(nextBinding ? [...next, nextBinding] : next);
  };

  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <Icons.Refresh size={18} />
        <h3 className="section-title">SQL 参数绑定</h3>
      </div>

      {sqlVariables.length === 0 ? (
        <div
          style={{
            padding: 28,
            borderRadius: 'var(--radius-lg)',
            border: '1px dashed var(--color-border)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text-muted)',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          还没有识别到 SQL 变量。请先进入 SQL 编辑页确认语句，保存草稿后这里会自动列出待绑定的参数。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sqlVariables.map((variableKey) => {
            const binding = getBinding(variableKey);
            const isStatic = binding?.staticValue !== undefined && !binding.customParamKey;

            return (
              <div
                key={variableKey}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(180px, 0.9fr) 18px minmax(280px, 1.1fr)',
                  gap: 16,
                  alignItems: 'center',
                  padding: '12px 16px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  background: 'white',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{variableKey}</strong>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 800,
                        padding: '2px 8px',
                        borderRadius: 999,
                        background: 'color-mix(in srgb, var(--color-primary-accent) 10%, white)',
                        color: 'var(--color-primary-accent)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                      }}
                    >
                      SQL 变量
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    确认运行时这个变量该从哪个 API 入参读取，或直接写死为固定静态值。
                  </span>
                </div>

                <Icons.ChevronRight size={16} style={{ color: 'var(--color-text-muted)' }} />

                <div style={{ display: 'flex', gap: 8 }}>
                  <select
                    className="form-select"
                    style={{ flex: 1, height: 36, minWidth: 190 }}
                    value={isStatic ? '__static__' : binding?.customParamKey || ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (!value) {
                        upsertBinding(variableKey, null);
                        return;
                      }
                      if (value === '__static__') {
                        upsertBinding(variableKey, {
                          variableKey,
                          staticValue: binding?.staticValue || '',
                        });
                        return;
                      }
                      upsertBinding(variableKey, {
                        variableKey,
                        customParamKey: value,
                      });
                    }}
                  >
                    <option value="">-- 自动按同名变量读取 --</option>
                    <optgroup label="API 入参">
                      {customParams.map((param) => (
                        <option key={param.key} value={param.key}>
                          {param.key} ({param.type})
                        </option>
                      ))}
                    </optgroup>
                    <option value="__static__">固定静态值</option>
                  </select>

                  {isStatic && (
                    <input
                      className="form-input"
                      style={{ flex: 1, height: 36 }}
                      placeholder="输入固定静态值"
                      value={binding?.staticValue || ''}
                      onChange={(event) =>
                        upsertBinding(variableKey, {
                          variableKey,
                          staticValue: event.target.value,
                        })
                      }
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DebugResultPanel({
  payload,
}: {
  payload: DebugPayload;
}) {
  if (!payload) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-muted)' }}>
        运行调试后，这里会在左侧展示 SQL / 绑定 / 缓存信息，右侧展示数据与接口返回预览。
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
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(300px, 0.88fr) minmax(0, 1.45fr)',
        gap: 16,
        alignItems: 'start',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        {'previewSql' in meta && (
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icons.Code size={16} />
              <strong style={{ fontSize: 14 }}>执行预览 SQL</strong>
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.7,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
                maxHeight: 320,
                overflow: 'auto',
              }}
            >
              {String(meta.previewSql || '')}
            </pre>
          </div>
        )}

        {'resolvedBindings' in meta && (
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icons.Layers size={16} />
              <strong style={{ fontSize: 14 }}>绑定明细</strong>
            </div>
            {Array.isArray(meta.resolvedBindings) && meta.resolvedBindings.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(meta.resolvedBindings as Array<{ variableKey: string; source: string; value: unknown }>).map((item) => (
                  <div
                    key={item.variableKey}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 1fr 1fr',
                      gap: 12,
                      padding: '10px 12px',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      fontSize: 12,
                      background: 'var(--color-bg-subtle)',
                    }}
                  >
                    <strong>{item.variableKey}</strong>
                    <span style={{ color: 'var(--color-text-muted)' }}>{item.source}</span>
                    <code style={{ overflowWrap: 'anywhere' }}>{JSON.stringify(item.value)}</code>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>当前没有变量绑定。</div>
            )}
          </div>
        )}

        {'cache' in meta && (
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icons.Database size={16} />
              <strong style={{ fontSize: 14 }}>Redis 缓存状态</strong>
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.7,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
                maxHeight: 280,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(meta.cache, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.Activity size={16} />
              <strong style={{ fontSize: 14 }}>SQL 数据预览</strong>
            </div>
            {!payload.error && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--color-border)',
                  background: 'rgba(248, 250, 252, 0.9)',
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--color-text-muted)',
                }}
              >
                {payload.summary || `共返回 ${rows.length} 行`}
              </span>
            )}
          </div>

          {payload.error ? (
            <pre
              style={{
                margin: 0,
                color: 'var(--color-danger)',
                background: 'var(--color-danger-soft)',
                border: '1px solid color-mix(in srgb, var(--color-danger) 24%, white)',
                borderRadius: 'var(--radius-md)',
                padding: 16,
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            >
              {payload.error}
            </pre>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, fontSize: 12, color: 'var(--color-text-muted)' }}>执行成功，但当前没有返回数据。</div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
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
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid var(--color-border)',
                background: 'rgba(248, 250, 252, 0.9)',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--color-text-muted)',
              }}
            >
              HTTP {payload.status || '--'}
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 12,
              lineHeight: 1.7,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-secondary)',
              maxHeight: 360,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(responsePreview, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default function DbApiPage() {
  const router = useRouter();

  const [dbApis, setDbApis] = useState<DbApiSummary[]>([]);
  const [databaseInstances, setDatabaseInstances] = useState<DatabaseInstanceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDraftKey, setActiveDraftKey] = useState<string | null>(null);
  const [isDraftOpen, setIsDraftOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('design');
  const [searchQuery, setSearchQuery] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [name, setName] = useState('');
  const [apiGroup, setApiGroup] = useState('未分组');
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('');
  const [customParams, setCustomParams] = useState<CustomParamDef[]>([]);
  const [databaseInstanceId, setDatabaseInstanceId] = useState('');
  const [sqlTemplate, setSqlTemplate] = useState('');
  const [paramBindings, setParamBindings] = useState<SqlVariableBinding[]>([]);
  const [redisConfig, setRedisConfig] = useState<RedisCacheConfig>({ enabled: false });
  const [runParams, setRunParams] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<DebugPayload>(null);
  const [runTime, setRunTime] = useState<number | null>(null);
  const [previewLimit, setPreviewLimit] = useState('10');
  const [isRunning, setIsRunning] = useState(false);
  const [baselineSignature, setBaselineSignature] = useState('');
  const [hasUserEdited, setHasUserEdited] = useState(false);
  const [navigationState, setNavigationState] = useState<{ editId: string | null; draftKey: string | null }>({
    editId: null,
    draftKey: null,
  });
  const [navigationReady, setNavigationReady] = useState(false);

  const toastTimerRef = useRef<number | null>(null);
  const handledNavigationKeyRef = useRef<string | null>(null);

  const sqlInstances = useMemo(
    () => databaseInstances.filter((item) => item.type === 'mysql' || item.type === 'pgsql'),
    [databaseInstances]
  );
  const redisInstances = useMemo(
    () => databaseInstances.filter((item) => item.type === 'redis'),
    [databaseInstances]
  );
  const hasRedisSources = redisInstances.length > 0;
  const sqlVariables = useMemo(() => extractSqlVariables(sqlTemplate), [sqlTemplate]);
  const selectedSqlInstance = useMemo(
    () => sqlInstances.find((item) => item.id === databaseInstanceId) || null,
    [databaseInstanceId, sqlInstances]
  );

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

  const applyConfig = useCallback((detail: DbApiConfig, options?: { draftKey?: string | null; id?: string | null }) => {
    const normalizedDetail = normalizeDbApiConfig(detail, options?.id || activeId);
    setIsDraftOpen(true);
    setHasUserEdited(false);
    setViewMode('design');
    setName(normalizedDetail.name);
    setApiGroup(normalizedDetail.apiGroup || '未分组');
    setDescription(normalizedDetail.description);
    setMethod(normalizedDetail.method);
    setPath(normalizedDetail.path);
    setCustomParams(normalizedDetail.customParams);
    setDatabaseInstanceId(normalizedDetail.databaseInstanceId);
    setSqlTemplate(normalizedDetail.sqlTemplate);
    setParamBindings(normalizedDetail.paramBindings);
    setRedisConfig(normalizedDetail.redisConfig || { enabled: false });
    setRunResult(null);
    setRunTime(null);
    setRunParams((current) => {
      const defaults = buildDebugDefaults(normalizedDetail.customParams);
      const next = { ...defaults, ...current };
      return Object.keys(defaults).reduce<Record<string, string>>((accumulator, key) => {
        accumulator[key] = next[key] ?? '';
        return accumulator;
      }, {});
    });
    setActiveDraftKey(options?.draftKey || null);
    setBaselineSignature(JSON.stringify(normalizedDetail));
  }, [activeId]);

  const fetchDbApis = useCallback(async () => {
    const response = await fetch('/api/db-apis');
    const data = (await response.json()) as DbApiSummary[];
    setDbApis(Array.isArray(data) ? data : []);
  }, []);

  const fetchDatabaseInstances = useCallback(async () => {
    const response = await fetch('/api/database-instances');
    const data = (await response.json()) as DatabaseInstanceSummary[];
    setDatabaseInstances(Array.isArray(data) ? data : []);
  }, []);

  const fetchDetail = useCallback(
    async (id: string, options?: { draftKey?: string | null }) => {
      const response = await fetch(`/api/db-apis/${id}`);
      const detail = (await response.json()) as DbApiConfig;
      if (!response.ok) {
        const detailError = (detail as { error?: string }).error;
        throw new Error(typeof detailError === 'string' ? detailError : '读取 DB API 详情失败');
      }
      applyConfig(detail, { ...options, id });
      setActiveId(id);
    },
    [applyConfig]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const currentSearch = new URLSearchParams(window.location.search);
    setNavigationState({
      editId: currentSearch.get('edit'),
      draftKey: currentSearch.get('draft'),
    });
    setNavigationReady(true);
  }, []);

  useEffect(() => {
    if (!navigationReady) return;
    const queryEditId = navigationState.editId;
    const queryDraftKey = navigationState.draftKey;
    const navigationKey = `${queryEditId || ''}|${queryDraftKey || ''}`;
    if (handledNavigationKeyRef.current === navigationKey) return;
    handledNavigationKeyRef.current = navigationKey;

    void (async () => {
      try {
        await Promise.all([fetchDbApis(), fetchDatabaseInstances()]);

        if (isDbApiDraftKey(queryDraftKey)) {
          const draft = readDbApiDraft(queryDraftKey);
          if (draft) {
            applyConfig(draft, { draftKey: queryDraftKey, id: queryEditId || draft.id || null });
            const nextId = queryEditId || (draft.id && draft.id !== 'temp-db-api' ? draft.id : null);
            setActiveId(nextId);
            return;
          }
        }

        if (queryEditId) {
          await fetchDetail(queryEditId);
        }
      } catch (error) {
        console.error(error);
        showToast('初始化 DB API 页面失败', 'error');
      }
    })();
  }, [applyConfig, fetchDatabaseInstances, fetchDbApis, fetchDetail, navigationReady, navigationState.draftKey, navigationState.editId, showToast]);

  useEffect(() => {
    setRunParams((current) => {
      const defaults = buildDebugDefaults(customParams);
      const next = { ...defaults, ...current };
      return Object.keys(defaults).reduce<Record<string, string>>((accumulator, key) => {
        accumulator[key] = next[key] ?? '';
        return accumulator;
      }, {});
    });
  }, [customParams]);

  const resetEditor = useCallback(() => {
    const nextPath = `/query/${Math.random().toString(36).slice(2, 8)}`;
    if (activeDraftKey) {
      clearDbApiDraft(activeDraftKey);
    }
    setActiveId(null);
    setActiveDraftKey(null);
    setIsDraftOpen(true);
    setHasUserEdited(false);
    setViewMode('design');
    setName('');
    setApiGroup('未分组');
    setDescription('');
    setMethod('GET');
    setPath(nextPath);
    setCustomParams([]);
    setDatabaseInstanceId(sqlInstances[0]?.id || '');
    setSqlTemplate('');
    setParamBindings([]);
    setRedisConfig({ enabled: false });
    setRunParams({});
    setRunResult(null);
    setRunTime(null);
    setBaselineSignature(JSON.stringify({
      id: 'temp-db-api',
      name: '',
      apiGroup: '未分组',
      description: '',
      method: 'GET',
      path: nextPath,
      customParams: [],
      databaseInstanceId: sqlInstances[0]?.id || '',
      sqlTemplate: '',
      paramBindings: [],
      redisConfig: { enabled: false },
      createdAt: '',
      updatedAt: '',
    }));
    router.replace('/db-api');
  }, [activeDraftKey, router, sqlInstances]);

  const currentConfig: DbApiConfig = useMemo(
    () => normalizeDbApiConfig({
      id: activeId || 'temp-db-api',
      name,
      apiGroup,
      description,
      method,
      path,
      customParams,
      databaseInstanceId,
      sqlTemplate,
      paramBindings,
      redisConfig,
      createdAt: '',
      updatedAt: '',
    }),
    [activeId, apiGroup, customParams, databaseInstanceId, description, method, name, paramBindings, path, redisConfig, sqlTemplate]
  );
  const currentSignature = useMemo(() => JSON.stringify(currentConfig), [currentConfig]);
  const isDirty = Boolean(isDraftOpen) && hasUserEdited && currentSignature !== baselineSignature;

  const openSqlEditor = useCallback(() => {
    if (!databaseInstanceId) {
      showToast('请先选择数据库数据源，再进入 SQL 编辑页', 'error');
      return;
    }

    const nextDraftKey = activeDraftKey || createDbApiDraftKey(activeId);
    writeDbApiDraft(nextDraftKey, currentConfig);
    setActiveDraftKey(nextDraftKey);

    const query = new URLSearchParams();
    query.set('draft', nextDraftKey);
    if (activeId) {
      query.set('edit', activeId);
    }

    router.push(`/db-api/editor/${activeId || 'draft'}?${query.toString()}`);
  }, [activeDraftKey, activeId, currentConfig, databaseInstanceId, router, showToast]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(activeId ? `/api/db-apis/${activeId}` : '/api/db-apis', {
        method: activeId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentConfig),
      });
      const payload = await response.json();
      if (!response.ok) {
        showToast(payload.error || '保存失败', 'error');
        return false;
      }

      await fetchDbApis();
      if (activeDraftKey) {
        clearDbApiDraft(activeDraftKey);
      }
      setActiveId(payload.id);
      setHasUserEdited(false);
      applyConfig(payload, { draftKey: null });
      router.replace(`/db-api?edit=${payload.id}`);
      showToast(activeId ? 'DB API 已更新' : 'DB API 已创建');
      return true;
    } catch (error) {
      console.error(error);
      showToast('保存 DB API 失败', 'error');
      return false;
    }
  }, [activeDraftKey, activeId, applyConfig, currentConfig, fetchDbApis, router, showToast]);

  const handleSave = useCallback(() => {
    void saveCurrent();
  }, [saveCurrent]);

  const unsavedGuard = useUnsavedChangesGuard({
    enabled: true,
    isDirty,
    onSave: saveCurrent,
  });

  const handleOpenSqlEditor = useCallback(() => {
    const nextDraftKey = activeDraftKey || createDbApiDraftKey(activeId);
    const query = new URLSearchParams();
    query.set('draft', nextDraftKey);
    if (activeId) {
      query.set('edit', activeId);
    }
    const nextHref = `/db-api/editor/${activeId || 'draft'}?${query.toString()}`;

    unsavedGuard.confirmNavigation(nextHref, () => {
      openSqlEditor();
    });
  }, [activeDraftKey, activeId, openSqlEditor, unsavedGuard]);

  const handleDelete = async () => {
    if (!activeId) return;

    try {
      const response = await fetch(`/api/db-apis/${activeId}`, { method: 'DELETE' });
      const payload = await response.json();
      if (!response.ok) {
        showToast(payload.error || '删除失败', 'error');
        return;
      }

      await fetchDbApis();
      if (activeDraftKey) {
        clearDbApiDraft(activeDraftKey);
      }
      setActiveId(null);
      setActiveDraftKey(null);
      setIsDraftOpen(false);
      setHasUserEdited(false);
      setName('');
      setSqlTemplate('');
      setParamBindings([]);
      setRedisConfig({ enabled: false });
      setRunResult(null);
      setRunTime(null);
      router.replace('/db-api');
      showToast('DB API 已删除');
    } catch (error) {
      console.error(error);
      showToast('删除 DB API 失败', 'error');
    }
  };

  const handleRun = async () => {
    if (!databaseInstanceId) {
      showToast('请先选择数据库数据源', 'error');
      return;
    }
    if (!sqlTemplate.trim()) {
      showToast('请先进入 SQL 编辑页配置 SQL 语句', 'error');
      return;
    }

    setIsRunning(true);
    setRunResult(null);
    setRunTime(null);

    try {
      const startTime = Date.now();
      const response = await fetch('/api/db-apis/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: currentConfig,
          runParams,
          previewLimit: previewLimit ? Number.parseInt(previewLimit, 10) : undefined,
        }),
      });
      const payload = await response.json();
      setRunTime(Date.now() - startTime);
      setRunResult({
        status: response.status,
        ...payload,
      });

      if (!response.ok) {
        showToast(payload.error || '运行调试失败', 'error');
        return;
      }

      showToast('运行调试成功');
    } catch (error) {
      console.error(error);
      setRunResult({
        status: 500,
        error: error instanceof Error ? error.message : '运行调试失败',
      });
      showToast('运行调试失败', 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const filteredDbApis = useMemo(
    () =>
      dbApis.filter((item) =>
        `${item.name} ${item.path} ${item.apiGroup || ''}`.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [dbApis, searchQuery]
  );

  const groupedDbApis = useMemo(
    () =>
      filteredDbApis.reduce<Record<string, DbApiSummary[]>>((accumulator, item) => {
        const group = item.apiGroup || '未分组';
        if (!accumulator[group]) {
          accumulator[group] = [];
        }
        accumulator[group].push(item);
        return accumulator;
      }, {}),
    [filteredDbApis]
  );

  const runParamSqlBindings = useMemo(() => {
    const bindingMap = customParams.reduce<Record<string, string[]>>((accumulator, param) => {
      accumulator[param.key] = [];
      return accumulator;
    }, {});

    sqlVariables.forEach((variableKey) => {
      const binding = paramBindings.find((item) => item.variableKey === variableKey);
      if (binding?.staticValue !== undefined) {
        return;
      }

      const targetParamKey = binding?.customParamKey || variableKey;
      if (!bindingMap[targetParamKey]) {
        return;
      }

      if (!bindingMap[targetParamKey].includes(variableKey)) {
        bindingMap[targetParamKey].push(variableKey);
      }
    });

    return bindingMap;
  }, [customParams, paramBindings, sqlVariables]);

  const handleClearRunResult = useCallback(() => {
    setRunResult(null);
    setRunTime(null);
  }, []);

  const sqlPreview = useMemo(() => {
    if (!sqlTemplate.trim()) {
      return '暂未配置 SQL。请直接进入独立编辑页进行编写、联调与库表查看。';
    }
    const lines = sqlTemplate.trim().split('\n').slice(0, 5);
    return lines.join('\n');
  }, [sqlTemplate]);

  const redisStatusText = useMemo(() => {
    if (!hasRedisSources) return '未接入 Redis 数据源';
    if (!redisConfig.enabled) return '默认关闭';
    return '缓存已开启';
  }, [hasRedisSources, redisConfig.enabled]);

  const renderDesignMode = () => (
    <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'linear-gradient(180deg, rgba(248,250,252,0.8), rgba(255,255,255,0.98))' }}>
      <div style={{ display: 'grid', gap: 18 }}>
        <div
          className="card"
          style={{
            padding: 24,
            background:
              'radial-gradient(circle at top right, rgba(59, 130, 246, 0.08), transparent 30%), linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.96))',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1.05fr) minmax(320px, 0.95fr)', gap: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">说明描述</label>
                <textarea
                  className="form-input"
                  style={{ minHeight: 96, resize: 'vertical', paddingTop: 12 }}
                  placeholder="补充这个 DB API 的用途、返回数据范围或联调约束。"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">绑定数据库</label>
                <select
                  className="form-select"
                  value={databaseInstanceId}
                  onChange={(event) => setDatabaseInstanceId(event.target.value)}
                >
                  <option value="">-- 请选择 MySQL / PostgreSQL --</option>
                  {sqlInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>
                      {instance.name} · {instance.type.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-xl)',
                background: 'rgba(255,255,255,0.82)',
                padding: 18,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <strong style={{ fontSize: 15 }}>SQL 配置概览</strong>
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    不需要先手动保存整个 DB API；进入 SQL 编辑页后会实时读取当前数据库绑定。
                  </span>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={handleOpenSqlEditor}>
                  <Icons.ExternalLink size={14} />
                  前往编辑页
                </button>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span className="method-badge method-get" style={{ transform: 'scale(0.9)', transformOrigin: 'left' }}>
                  {sqlTemplate.trim() ? `${sqlVariables.length} 个变量` : '待配置 SQL'}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '5px 10px',
                    borderRadius: 999,
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-bg-subtle)',
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {selectedSqlInstance ? `${selectedSqlInstance.name} · ${selectedSqlInstance.type.toUpperCase()}` : '未选择数据库'}
                </span>
              </div>

              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  minHeight: 112,
                  maxHeight: 220,
                  overflow: 'auto',
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--color-bg-subtle)',
                  border: '1px solid var(--color-border)',
                  padding: 14,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1.7,
                }}
              >
                {sqlPreview}
              </pre>

              {sqlVariables.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {sqlVariables.map((variableKey) => (
                    <span
                      key={variableKey}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 999,
                        background: 'white',
                        border: '1px solid var(--color-border)',
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {`{{${variableKey}}}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <CustomParamEditor params={customParams} onChange={(next) => {
          setHasUserEdited(true);
          setCustomParams(next);
        }} />

        <SqlBindingEditor
          sqlVariables={sqlVariables}
          customParams={customParams}
          bindings={paramBindings}
          onChange={(next) => {
            setHasUserEdited(true);
            setParamBindings(next);
          }}
        />

        <div className="card" style={{ padding: 24 }}>
          <div className={styles.redisHeader}>
            <div className={styles.redisHeaderMain}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icons.Database size={18} />
                <h3 className="section-title">Redis 结果缓存</h3>
              </div>
              <p className={styles.redisHeaderDescription}>
                与 API 转发一致：默认关闭，开启后会按 <code>接口ID:规则</code> 生成缓存 Key，并在调试 / 实际访问后写入 Redis。
              </p>
            </div>
            <label className={styles.redisToggle}>
              <span className={`${styles.redisStatusBadge} ${redisConfig.enabled ? styles.redisStatusEnabled : styles.redisStatusDisabled}`}>
                {redisStatusText}
              </span>
              <input
                type="checkbox"
                checked={redisConfig.enabled}
                disabled={!hasRedisSources}
                onChange={(event) => {
                  if (event.target.checked && !hasRedisSources) {
                    showToast('暂无 Redis 数据源，请先前往「数据库实例」配置', 'error');
                    return;
                  }
                  setHasUserEdited(true);
                  setRedisConfig(sanitizeRedisCacheConfig({ ...redisConfig, enabled: event.target.checked }));
                }}
                style={{ width: 16, height: 16 }}
              />
            </label>
          </div>

          {!hasRedisSources && (
            <div className={styles.redisEmptyState}>
              <div className={styles.redisEmptyIcon}>
                <Icons.Info size={16} />
              </div>
              <div className={styles.redisEmptyContent}>
                <strong>请先接入 Redis 数据源</strong>
                <span>当前没有可用的 Redis 实例，因此暂时不能开启结果缓存。</span>
              </div>
            </div>
          )}

          {redisConfig.enabled && (
            <div className={styles.redisConfigGrid}>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">选择 Redis 数据源</label>
                <select
                  className="form-select"
                  value={redisConfig.instanceId || ''}
                  onChange={(event) => {
                    setHasUserEdited(true);
                    setRedisConfig(sanitizeRedisCacheConfig({ ...redisConfig, instanceId: event.target.value }));
                  }}
                >
                  <option value="">-- 请选择数据源 --</option>
                  {redisInstances.map((instance) => (
                    <option key={instance.id} value={instance.id}>
                      {instance.name} · {instance.connectionUri}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Redis Key 规则</label>
                <textarea
                  className={`${styles.redisRuleEditor} form-input`}
                  placeholder={'如: profile:{{userId}}\n或: order:{{$.order.id}}:{{items[0].sku}}'}
                  value={redisConfig.keyRule || ''}
                  onChange={(event) => {
                    setHasUserEdited(true);
                    setRedisConfig(sanitizeRedisCacheConfig({ ...redisConfig, keyRule: event.target.value }));
                  }}
                />
                <div className={styles.redisRuleHints}>
                  <span><code>{'{{userId}}'}</code> 读取普通参数</span>
                  <span><code>{'{{user.id}}'}</code> / <code>{'{{$.user.id}}'}</code> 读取 JSON 入参</span>
                  <span>最终写入 Key：<code>{`${activeId || 'temp_id'}:${redisConfig.keyRule || '...'}`}</code></span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">过期时间 (秒)</label>
                <input
                  type="number"
                  className="form-input"
                  placeholder="如: 3600 (一小时)"
                  min={1}
                  value={redisConfig.expireSeconds || ''}
                  onChange={(event) => {
                    setHasUserEdited(true);
                    setRedisConfig(
                      sanitizeRedisCacheConfig({
                        ...redisConfig,
                        expireSeconds: event.target.value ? Number.parseInt(event.target.value, 10) : undefined,
                      })
                    );
                  }}
                />
                <div className={styles.redisExpireHint}>留空表示不过期；写入失败不会中断真实 DB API 返回。</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderRunMode = () => (
    <div style={{ flex: 1, overflow: 'auto', background: 'linear-gradient(180deg, rgba(248,250,252,0.7), rgba(255,255,255,0.98))' }}>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1320 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.Activity size={16} />
              <strong style={{ fontSize: 14 }}>调试说明</strong>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: 14,
                alignItems: 'start',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--color-text-secondary)',
                    lineHeight: 1.75,
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-lg)',
                    background: 'linear-gradient(180deg, rgba(248,250,252,0.78), rgba(255,255,255,0.96))',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  调试不会要求你先保存整个 DB API；当前表单里的数据库、SQL、绑定关系和 Redis 缓存配置会直接参与本次执行。
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 10,
                  }}
                >
                  {[
                    {
                      label: '预览上限',
                      value: `${previewLimit || '10'} 条预览上限`,
                      accent: 'var(--color-primary-accent)',
                    },
                    {
                      label: '运行入口',
                      value: path || '/db-api/...',
                      accent: 'var(--color-success)',
                    },
                    {
                      label: '绑定数据库',
                      value: selectedSqlInstance?.name || '未选择',
                      accent: 'var(--color-warning)',
                    },
                    {
                      label: 'SQL 变量数',
                      value: `${sqlVariables.length} 个`,
                      accent: 'var(--color-text)',
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      style={{
                        padding: '12px 14px',
                        borderRadius: 'var(--radius-lg)',
                        border: '1px solid var(--color-border)',
                        background: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.92))',
                        boxShadow: 'var(--shadow-sm)',
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          color: 'var(--color-text-muted)',
                          marginBottom: 6,
                        }}
                      >
                        {item.label}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: item.accent,
                          fontFamily: item.label === '运行入口' ? 'var(--font-mono)' : 'inherit',
                          whiteSpace: item.label === '预览上限' ? 'nowrap' : 'normal',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-lg)',
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(248,250,252,0.86))',
                    overflow: 'hidden',
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      padding: '10px 12px',
                      borderBottom: '1px solid var(--color-border)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11,
                      fontWeight: 800,
                      color: 'var(--color-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    <Icons.Code size={14} />
                    执行 SQL 模版预览
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: '12px 14px',
                      maxHeight: 148,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 12,
                      lineHeight: 1.75,
                      fontFamily: 'var(--font-mono)',
                      color: sqlTemplate.trim() ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
                      background: 'rgba(255,255,255,0.72)',
                    }}
                  >
                    {sqlTemplate.trim() || '暂未配置 SQL 模版，请先前往 SQL 编辑页编写 SQL。'}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 16,
              marginBottom: 18,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.Settings size={18} />
              <h3 className="section-title">运行调试参数</h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '0 14px',
                  height: 38,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-bg-subtle)',
                  border: '1px solid var(--color-border)',
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
                  style={{ width: 80, border: 'none', height: 28, padding: 0, fontFamily: 'var(--font-mono)', background: 'transparent' }}
                />
              </div>
              <button className="btn btn-primary" onClick={handleRun} disabled={isRunning}>
                <Icons.Zap size={16} />
                {isRunning ? '执行中...' : '运行调试'}
              </button>
            </div>
          </div>

          {customParams.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-lg)', color: 'var(--color-text-muted)', fontSize: 13, border: '1px dashed var(--color-border)' }}>
              当前没有自定义入参，可以直接执行调试。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {customParams.map((param) => {
                const boundVariables = runParamSqlBindings[param.key] || [];

                return (
                  <div
                    key={param.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(180px, 220px) minmax(220px, 1fr) minmax(220px, 1fr)',
                      gap: 14,
                      alignItems: 'center',
                      padding: '14px 16px',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-lg)',
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.9))',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                        <label style={{ fontSize: 13, fontWeight: 700 }}>{param.key}</label>
                        <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--color-bg-hover)', padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
                          {param.type}
                        </span>
                        {param.description && (
                          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {param.description}
                          </span>
                        )}
                      </div>
                      {param.defaultValue && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                          默认值：<code>{param.defaultValue}</code>
                        </span>
                      )}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <input
                        type={param.type === 'number' || param.type === 'integer' ? 'number' : 'text'}
                        value={runParams[param.key] || ''}
                        onChange={(event) => setRunParams((current) => ({ ...current, [param.key]: event.target.value }))}
                        placeholder={param.defaultValue ? `默认值: ${param.defaultValue}` : `请输入 ${param.key} 的值`}
                        className="form-input"
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)' }}>绑定 SQL 变量</span>
                      {boundVariables.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {boundVariables.map((variableKey) => (
                            <span
                              key={`${param.key}-${variableKey}`}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '4px 10px',
                                borderRadius: 999,
                                border: '1px solid var(--color-border)',
                                background: 'rgba(255,255,255,0.92)',
                                fontSize: 11,
                                fontWeight: 700,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--color-text-secondary)',
                              }}
                            >
                              {`{{${variableKey}}}`}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>当前未绑定到 SQL 变量。</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'white', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', marginRight: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>模块</span>
                <span style={{ fontSize: 14, fontWeight: 800 }}>运行调试结果</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>响应状态</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: runResult?.status && runResult.status >= 200 && runResult.status < 300 ? 'var(--color-success)' : 'var(--color-text)' }}>
                  {runResult?.status || '--'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>执行耗时</span>
                <span style={{ fontSize: 14, fontWeight: 800 }}>{runTime !== null ? `${runTime}ms` : '--'}</span>
              </div>
            </div>

            {runResult !== null && (
              <button className="btn btn-secondary btn-sm" onClick={handleClearRunResult}>
                清除结果
              </button>
            )}
          </div>

          <div style={{ padding: 20, background: 'var(--color-bg-subtle)' }}>
            <DebugResultPanel payload={runResult} />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className={styles.workspace}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTitle}>
            <span>DB API 列表</span>
            <button className="btn btn-icon btn-ghost" onClick={() => unsavedGuard.confirmAction(() => resetEditor())} title="新建 DB API">
              <Icons.Plus size={18} />
            </button>
          </div>
          <div className="search-bar" style={{ maxWidth: '100%' }}>
            <Icons.Search className="search-bar-icon" size={14} />
            <input
              type="text"
              className="search-bar-input"
              style={{ height: 36 }}
              placeholder="搜索 DB API..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
        </div>

        <div className={styles.apiList}>
          {Object.keys(groupedDbApis).length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>
              <Icons.Database size={48} strokeWidth={1} style={{ opacity: 0.3, marginBottom: 16 }} />
              <div style={{ fontSize: 13 }}>暂无 DB API 配置</div>
            </div>
          ) : (
            Object.entries(groupedDbApis).map(([group, list]) => (
              <div key={group}>
                <div
                  style={{
                    padding: '8px 12px',
                    fontSize: 11,
                    fontWeight: 800,
                    color: 'var(--color-text-muted)',
                    background: 'var(--color-bg-subtle)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    margin: '2px 4px',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  {group}
                </div>
                {list.map((item) => (
                  <div
                    key={item.id}
                    className={`${styles.apiItem} ${activeId === item.id ? styles.active : ''}`}
                    style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-bg-subtle)' }}
                    onClick={() => {
                      unsavedGuard.confirmAction(async () => {
                        router.replace(`/db-api?edit=${item.id}`);
                        clearDbApiDraft(activeDraftKey);
                        setActiveDraftKey(null);
                        await fetchDetail(item.id).catch((error) => {
                          console.error(error);
                          showToast(error instanceof Error ? error.message : '读取 DB API 失败', 'error');
                        });
                      });
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span className={`method-badge method-${item.method.toLowerCase()}`} style={{ transform: 'scale(0.8)', transformOrigin: 'left' }}>
                        {item.method}
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--color-text)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {item.name}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--color-text-muted)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {item.path}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      <main className={styles.mainPanel}>
        {!activeId && !isDraftOpen ? (
          <div className={styles.emptyCenter}>
            <div
              style={{
                width: 84,
                height: 84,
                background: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-xl)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-muted)',
              }}
            >
              <Icons.Database size={40} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700 }}>DB API 工作台</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 14, maxWidth: 460, textAlign: 'center' }}>
              主页面专注接口入参、数据源、运行调试和缓存配置；SQL 编写、预览与库表查看则进入独立编辑页处理。
            </p>
            <button className="btn btn-primary" onClick={() => unsavedGuard.confirmAction(() => resetEditor())}>
              <Icons.Plus size={18} />
              新建 DB API
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <div
              style={{
                padding: '16px 24px',
                borderBottom: '1px solid var(--color-border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'white',
                gap: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, minWidth: 0 }}>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 260 }}>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => {
                      setHasUserEdited(true);
                      setName(event.target.value);
                    }}
                    className="form-input"
                    style={{ border: 'none', background: 'transparent', fontSize: 18, fontWeight: 800, padding: 0, height: 'auto', marginBottom: 2 }}
                    placeholder="请输入 DB API 名称"
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icons.Layers size={12} style={{ color: 'var(--color-text-muted)' }} />
                    <input
                      type="text"
                      value={apiGroup}
                      onChange={(event) => {
                        setHasUserEdited(true);
                        setApiGroup(event.target.value);
                      }}
                      className="form-input"
                      style={{ width: 160, height: 'auto', fontSize: 12, padding: 0, border: 'none', background: 'transparent', fontWeight: 600, color: 'var(--color-text-secondary)' }}
                      placeholder="分组名称..."
                    />
                  </div>
                </div>

                <div className="tabs" style={{ margin: 0, height: 40, width: 240 }}>
                  <button className={`tab ${viewMode === 'design' ? 'active' : ''}`} onClick={() => setViewMode('design')}>
                    配置设计
                  </button>
                  <button className={`tab ${viewMode === 'run' ? 'active' : ''}`} onClick={() => setViewMode('run')}>
                    运行调试
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
                <button className="btn btn-secondary" onClick={handleOpenSqlEditor}>
                  <Icons.Code size={16} />
                  前往 SQL 编辑页
                </button>
                {activeId && (
                  <button className="btn btn-ghost btn-icon" onClick={handleDelete} title="删除">
                    <Icons.Trash size={18} style={{ color: 'var(--color-danger)' }} />
                  </button>
                )}
                <button className="btn btn-primary" onClick={handleSave}>
                  保存 DB API
                </button>
              </div>
            </div>

            <div style={{ padding: '24px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-subtle)' }}>
              <div style={{ display: 'flex', gap: 12, maxWidth: 1120, alignItems: 'center' }}>
                <div
                  style={{
                    display: 'flex',
                    flex: 1,
                    background: 'white',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    boxShadow: 'var(--shadow-sm)',
                  }}
                >
                  <select
                    value={method}
                    onChange={(event) => {
                      setHasUserEdited(true);
                      setMethod(event.target.value);
                    }}
                    className="form-select"
                    style={{ width: 110, border: 'none', borderRight: '1px solid var(--color-border)', borderRadius: 0, fontWeight: 700, fontSize: 13, height: 42 }}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                  <input
                    type="text"
                    value={path}
                    onChange={(event) => {
                      setHasUserEdited(true);
                      setPath(event.target.value);
                    }}
                    className="form-input"
                    style={{ flex: 1, border: 'none', fontFamily: 'var(--font-mono)', fontSize: 13 }}
                    placeholder="/query/orders"
                  />
                </div>

              </div>
            </div>

            {viewMode === 'design' ? renderDesignMode() : renderRunMode()}
          </div>
        )}
      </main>

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

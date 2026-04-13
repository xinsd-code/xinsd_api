'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  getEffectiveDatabaseMetricMappings,
  getDatabaseInstanceValidationSignature,
  sanitizeDatabaseInstanceInput,
  validateDatabaseInstanceInput,
} from '@/lib/database-instances';
import {
  CreateDatabaseInstance,
  DatabaseCollectionInfo,
  DatabaseFieldMetricMapping,
  DatabaseInstance,
  DatabaseInstanceSummary,
  DatabaseInstanceType,
  DatabaseQueryPayload,
  DatabaseSchemaPayload,
} from '@/lib/types';
import { Icons } from '@/components/Icons';
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog';
import { isDateLikeType, isNumericType, isTextLikeType } from '@/lib/db-harness/core/utils';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import styles from './page.module.css';

type PanelMode = 'overview' | 'create' | 'edit' | 'detail';
type ValidationState = 'idle' | 'success' | 'error';
type FieldSemanticFilter = 'all' | 'metric' | 'dimension' | 'time' | 'identifier' | 'attribute';

interface EditableInstance {
  name: string;
  type: DatabaseInstanceType;
  connectionUri: string;
  username: string;
  password: string;
}

function createEmptyDraft(): EditableInstance {
  return {
    name: '',
    type: 'mysql',
    connectionUri: '',
    username: '',
    password: '',
  };
}

function toEditableInstance(instance: DatabaseInstance): EditableInstance {
  return {
    name: instance.name,
    type: instance.type,
    connectionUri: instance.connectionUri,
    username: instance.username || '',
    password: instance.password || '',
  };
}

function getConnectionPlaceholder(type: DatabaseInstanceType): string {
  if (type === 'mysql') return 'jdbc:mysql://localhost:3306/my_chat';
  if (type === 'pgsql') return 'jdbc:postgresql://localhost:5432/my_chat';
  return 'localhost:6379';
}

function getConnectionExample(type: DatabaseInstanceType): string {
  if (type === 'mysql') return '示例：jdbc:mysql://localhost:3306/my_chat，用户 root / 密码 root';
  if (type === 'pgsql') return '示例：jdbc:postgresql://localhost:5432/my_chat，用户 root / 密码 root';
  return '示例：localhost:6379（无鉴权可留空用户名和密码）';
}

function getDefaultValidationMessage(state: ValidationState): string {
  if (state === 'success') return '连接验证通过，可以保存该数据库实例。';
  if (state === 'error') return '连接验证未通过，请修正连接信息后重试。';
  return '保存前请先验证连接，确保实例可用。';
}

function maskConnectionUri(connectionUri: string, type: DatabaseInstanceType): string {
  const value = connectionUri.trim();
  if (!value) return '等待填写连接地址';

  if (type === 'redis') {
    const [host, port] = value.replace(/^redis:\/\//, '').split(':');
    if (!host || !port) return '已配置连接地址';
    const hostMasked = host.length <= 4 ? `${host[0] || '*'}***` : `${host.slice(0, 2)}***${host.slice(-1)}`;
    return `${hostMasked}:${port}`;
  }

  const match = value.match(/^(jdbc:(?:mysql|postgresql):\/\/)([^/:]+)(:\d+\/)(.+)$/);
  if (!match) return '已配置连接地址';
  const [, prefix, host, portAndSlash, database] = match;
  const hostMasked = host.length <= 4 ? `${host[0] || '*'}***` : `${host.slice(0, 2)}***${host.slice(-1)}`;
  const dbMasked = database.length <= 3 ? `${database[0] || '*'}**` : `${database.slice(0, 2)}***${database.slice(-1)}`;
  return `${prefix}${hostMasked}${portAndSlash}${dbMasked}`;
}

function getDefaultQuery(type: DatabaseInstanceType, collectionName?: string): string {
  if (type === 'mysql') {
    return collectionName ? `SELECT * FROM \`${collectionName}\` LIMIT 50;` : 'SHOW TABLES;';
  }
  if (type === 'pgsql') {
    return collectionName ? `SELECT * FROM "${collectionName}" LIMIT 50;` : 'SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\';';
  }
  return collectionName ? `TYPE ${collectionName}` : 'SCAN 0 MATCH * COUNT 50';
}

function getQueryHint(type: DatabaseInstanceType): string {
  if (type === 'redis') {
    return '支持只读命令：GET / HGETALL / LRANGE / SMEMBERS / ZRANGE / TYPE / TTL / EXISTS / SCAN / KEYS';
  }
  return '当前仅允许执行只读 SQL：SELECT / SHOW / DESCRIBE / DESC / EXPLAIN / WITH';
}

function renderCellValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function getApiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }
  return fallback;
}

async function readApiJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok) {
      throw new Error(fallback);
    }
    throw new Error('接口返回格式异常，请稍后重试');
  }
}

function getStructurePanelSubtitle(
  instanceType: DatabaseInstanceType,
  selectedInfo: DatabaseCollectionInfo | null,
  selectedName: string | null
): string {
  if (!selectedName) {
    return instanceType === 'redis' ? '请选择一个 Redis Key' : '请选择一张表查看字段属性';
  }
  if (selectedInfo?.category === 'table') {
    return `当前表：${selectedInfo.name}`;
  }
  return instanceType === 'redis' ? `当前 Key：${selectedName}` : `当前对象：${selectedName}`;
}

function formatMetricAliases(aliases?: string[]): string {
  if (!aliases?.length) return '-';
  return aliases.join(' / ');
}

function inferFieldSemanticRole(
  column: NonNullable<DatabaseCollectionInfo['columns']>[number],
  metric?: DatabaseFieldMetricMapping
): Exclude<FieldSemanticFilter, 'all'> {
  const metricType = (metric?.metricType || '').toLowerCase();
  const calcMode = (metric?.calcMode || '').toLowerCase();
  const name = column.name.toLowerCase();

  if (metricType.includes('时间') || metricType.includes('time') || isDateLikeType(column.type)) {
    return 'time';
  }
  if (
    column.isPrimary
    || metricType.includes('标识')
    || metricType.includes('id')
    || /(^id$|_id$|uuid|code$)/i.test(name)
  ) {
    return 'identifier';
  }
  if (
    metricType.includes('度量')
    || metricType.includes('指标')
    || metricType.includes('metric')
    || calcMode.includes('求和')
    || calcMode.includes('平均')
    || calcMode.includes('计数')
    || calcMode.includes('count')
    || isNumericType(column.type)
  ) {
    return 'metric';
  }
  if (metricType.includes('维度') || metricType.includes('dimension') || isTextLikeType(column.type)) {
    return 'dimension';
  }
  return 'attribute';
}

function DatabaseInstancesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const detailInstanceId = searchParams.get('detail');
  const detailCollectionName = searchParams.get('collection');
  const [instances, setInstances] = useState<DatabaseInstanceSummary[]>([]);
  const [panelMode, setPanelMode] = useState<PanelMode>('overview');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailInstance, setDetailInstance] = useState<DatabaseInstance | null>(null);
  const [draft, setDraft] = useState<EditableInstance>(createEmptyDraft);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [validationState, setValidationState] = useState<ValidationState>('idle');
  const [validationMessage, setValidationMessage] = useState(getDefaultValidationMessage('idle'));
  const [validatedSignature, setValidatedSignature] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaData, setSchemaData] = useState<DatabaseSchemaPayload | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [isStructureCollapsed, setIsStructureCollapsed] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryResult, setQueryResult] = useState<DatabaseQueryPayload | null>(null);
  const [fieldSemanticFilter, setFieldSemanticFilter] = useState<FieldSemanticFilter>('all');
  const [mappedOnly, setMappedOnly] = useState(false);
  const [relatedOnly, setRelatedOnly] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [baselineSignature, setBaselineSignature] = useState(() => getDatabaseInstanceValidationSignature(sanitizeDatabaseInstanceInput(createEmptyDraft())));

  const activeInstance = useMemo(
    () => instances.find((item) => item.id === activeId) || null,
    [instances, activeId]
  );
  const activeDetail = useMemo(
    () => (detailInstance && detailInstance.id === activeId ? detailInstance : null),
    [detailInstance, activeId]
  );
  const engineCounts = useMemo(() => ({
    mysql: instances.filter((item) => item.type === 'mysql').length,
    pgsql: instances.filter((item) => item.type === 'pgsql').length,
    redis: instances.filter((item) => item.type === 'redis').length,
  }), [instances]);
  const payload = useMemo<CreateDatabaseInstance>(() => sanitizeDatabaseInstanceInput({
    name: draft.name,
    type: draft.type,
    connectionUri: draft.connectionUri,
    username: draft.username,
    password: draft.password,
  }), [draft]);
  const payloadSignature = useMemo(() => getDatabaseInstanceValidationSignature(payload), [payload]);
  const isDirty = payloadSignature !== baselineSignature;
  const isValidationFresh = validationState === 'success' && validatedSignature === payloadSignature;
  const selectedCollectionInfo = useMemo(
    () => schemaData?.collections.find((item) => item.name === selectedCollection) || null,
    [schemaData, selectedCollection]
  );
  const sanitizedMetricMappings = useMemo(
    () => getEffectiveDatabaseMetricMappings({
      metricMappings: activeDetail?.metricMappings,
      semanticModel: activeDetail?.semanticModel,
    }),
    [activeDetail]
  );
  const selectedMetricMappings = useMemo(
    () => (selectedCollection ? sanitizedMetricMappings[selectedCollection]?.fields || {} : {}),
    [sanitizedMetricMappings, selectedCollection]
  );
  const selectedMetricCount = useMemo(
    () => Object.keys(selectedMetricMappings).length,
    [selectedMetricMappings]
  );
  const selectedMetricTotal = selectedCollectionInfo?.columns?.length || 0;
  const filteredColumns = useMemo(() => {
    const columns = selectedCollectionInfo?.columns || [];
    return columns.filter((column) => {
      const metric = selectedMetricMappings[column.name];
      const semanticRole = inferFieldSemanticRole(column, metric);

      if (fieldSemanticFilter !== 'all' && semanticRole !== fieldSemanticFilter) {
        return false;
      }
      if (mappedOnly && !metric) {
        return false;
      }
      if (relatedOnly && !column.referencesTable) {
        return false;
      }
      return true;
    });
  }, [fieldSemanticFilter, mappedOnly, relatedOnly, selectedCollectionInfo?.columns, selectedMetricMappings]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  }, []);

  const syncDetailState = useCallback((detail: DatabaseInstance | null) => {
    setDetailInstance(detail);
  }, []);

  const resetExplorerState = useCallback(() => {
    setSchemaData(null);
    setSelectedCollection(null);
    setFieldSemanticFilter('all');
    setMappedOnly(false);
    setRelatedOnly(false);
    setQueryResult(null);
    setQueryText('');
  }, []);

  const resetEditorState = useCallback((mode: PanelMode, instance?: DatabaseInstance | null) => {
    const nextDraft = instance ? toEditableInstance(instance) : createEmptyDraft();
    setPanelMode(mode);
    setActiveId(instance?.id || null);
    syncDetailState(instance || null);
    setDraft(nextDraft);
    setBaselineSignature(getDatabaseInstanceValidationSignature(sanitizeDatabaseInstanceInput(nextDraft)));
    setShowPassword(false);
    setValidationState('idle');
    setValidationMessage(getDefaultValidationMessage('idle'));
    setValidatedSignature(null);
    resetExplorerState();
  }, [resetExplorerState, syncDetailState]);

  const fetchInstances = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/database-instances');
      if (!res.ok) {
        throw new Error('获取数据库实例失败');
      }
      const data = await res.json() as DatabaseInstanceSummary[];
      setInstances(data);
      return data;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取数据库实例失败', 'error');
      return null;
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const data = await fetchInstances();
      if (!data || cancelled) return;

      if (!detailInstanceId) {
        resetEditorState('overview');
        return;
      }

      const matched = data.find((item) => item.id === detailInstanceId);
      if (!matched) {
        resetEditorState('overview');
        showToast('目标数据库实例不存在', 'error');
        return;
      }

      setActiveId(detailInstanceId);
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/database-instances/${detailInstanceId}`);
        if (!res.ok) throw new Error('读取详情失败');
        const detail = await res.json() as DatabaseInstance;
        if (!cancelled) {
          resetEditorState('detail', detail);
        }
      } catch {
        if (!cancelled) {
          showToast('获取数据库实例详情失败', 'error');
          resetEditorState('overview');
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [detailInstanceId, fetchInstances, resetEditorState, showToast]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!validatedSignature) return;
    if (validatedSignature === payloadSignature) return;
    setValidationMessage('连接信息已变更，请重新验证后再保存。');
  }, [payloadSignature, validatedSignature]);

  const updateDraft = <K extends keyof EditableInstance>(key: K, value: EditableInstance[K]) => {
    setDraft((prev) => ({
      ...prev,
      [key]: value,
      ...(key === 'type'
        ? {
            connectionUri: '',
            username: '',
            password: '',
          }
        : {}),
    }));
  };

  const validateDraft = useCallback((): string | null => validateDatabaseInstanceInput(payload), [payload]);

  const applyCreateNew = useCallback(() => {
    resetEditorState('create');
  }, [resetEditorState]);

  const loadInstanceDetail = useCallback(async (instance: DatabaseInstanceSummary) => {
    setActiveId(instance.id);
    setPanelMode('edit');
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/database-instances/${instance.id}`);
      if (!res.ok) throw new Error('读取详情失败');
      const detail = await res.json() as DatabaseInstance;
      resetEditorState('edit', detail);
    } catch {
      showToast('获取数据库实例详情失败', 'error');
    } finally {
      setDetailLoading(false);
    }
  }, [resetEditorState, showToast]);

  const handleTestConnection = async () => {
    const validationError = validateDraft();
    if (validationError) {
      setValidationState('error');
      setValidationMessage(validationError);
      showToast(validationError, 'error');
      return;
    }

    setTesting(true);
    try {
      const res = await fetch('/api/database-instances/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiJson<{ error?: string; message?: string; signature?: string }>(res, '连接验证失败');
      if (!res.ok) {
        setValidationState('error');
        const message = getApiErrorMessage(data, '连接验证失败');
        setValidationMessage(message);
        setValidatedSignature(data.signature || payloadSignature);
        throw new Error(message);
      }
      setValidationState('success');
      setValidationMessage(data.message || getDefaultValidationMessage('success'));
      setValidatedSignature(data.signature || payloadSignature);
      showToast(data.message || '连接验证通过');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '连接验证失败', 'error');
    } finally {
      setTesting(false);
    }
  };

  const loadSchema = useCallback(async (instanceId: string) => {
    try {
      setSchemaLoading(true);
      const res = await fetch(`/api/database-instances/${instanceId}/schema`);
      const data = await readApiJson<DatabaseSchemaPayload & { error?: string }>(res, '读取数据库结构失败');
      if (!res.ok) {
        throw new Error(getApiErrorMessage(data, '读取数据库结构失败'));
      }
      setSchemaData(data);
      const preferredCollection = detailCollectionName && data.collections.some((item) => item.name === detailCollectionName)
        ? detailCollectionName
        : null;
      const firstCollection = preferredCollection || data.collections?.[0]?.name || null;
      setSelectedCollection(firstCollection);
      setQueryResult(null);
      if (activeInstance) {
        setQueryText(getDefaultQuery(activeInstance.type, firstCollection || undefined));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取数据库结构失败', 'error');
      setSchemaData(null);
      setSelectedCollection(null);
    } finally {
      setSchemaLoading(false);
    }
  }, [activeInstance, detailCollectionName, showToast]);

  useEffect(() => {
    if (!activeId || !panelMode || panelMode === 'overview' || panelMode === 'create') return;
    if (activeDetail) return;
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`/api/database-instances/${activeId}`);
        if (!res.ok) throw new Error('读取详情失败');
        const detail = await res.json() as DatabaseInstance;
        if (!cancelled) {
          syncDetailState(detail);
        }
      } catch {
        if (!cancelled) {
          showToast('获取数据库实例详情失败', 'error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeDetail, activeId, panelMode, showToast, syncDetailState]);

  useEffect(() => {
    if (panelMode !== 'detail' || !activeId || !activeInstance) return;
    if (activeInstance.type === 'redis') {
      setSchemaData(null);
      setSelectedCollection(null);
      setQueryResult(null);
      setQueryText(getDefaultQuery(activeInstance.type));
      return;
    }
    void loadSchema(activeId);
  }, [panelMode, activeId, activeInstance, loadSchema]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    const validationError = validateDraft();
    if (validationError) {
      showToast(validationError, 'error');
      return false;
    }
    if (!isValidationFresh) {
      const nextMessage = validatedSignature && validatedSignature !== payloadSignature
        ? '连接信息已变更，请重新验证后再保存。'
        : '请先验证连接，确认实例可用后再保存。';
      setValidationState('idle');
      setValidationMessage(nextMessage);
      showToast(nextMessage, 'error');
      return false;
    }

    setSaving(true);
    try {
      const res = await fetch(activeId ? `/api/database-instances/${activeId}` : '/api/database-instances', {
        method: activeId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiJson<{ id?: string; error?: string }>(res, '保存数据库实例失败');
      if (!res.ok) {
        throw new Error(getApiErrorMessage(data, '保存数据库实例失败'));
      }

      const instancesData = await fetchInstances();
      if (instancesData) {
        if (activeId) {
          resetEditorState('edit', data as DatabaseInstance);
        } else {
          resetEditorState('overview');
        }
      }
      showToast(activeId ? '数据库实例已更新' : '数据库实例已创建');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存数据库实例失败', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [activeId, fetchInstances, isValidationFresh, payload, payloadSignature, resetEditorState, showToast, validateDraft, validatedSignature]);

  const handleSave = useCallback(() => {
    void saveCurrent();
  }, [saveCurrent]);

  const unsavedGuard = useUnsavedChangesGuard({
    enabled: panelMode === 'create' || panelMode === 'edit',
    isDirty,
    onSave: saveCurrent,
  });

  const handleCreateNew = useCallback(() => {
    unsavedGuard.confirmAction(() => {
      applyCreateNew();
    });
  }, [applyCreateNew, unsavedGuard]);

  const handleSelectInstance = useCallback((instance: DatabaseInstanceSummary) => {
    unsavedGuard.confirmAction(async () => {
      await loadInstanceDetail(instance);
    });
  }, [loadInstanceDetail, unsavedGuard]);

  const handleDelete = async () => {
    if (!activeId) return;
    if (!window.confirm('确认删除当前数据库实例吗？')) return;

    try {
      const res = await fetch(`/api/database-instances/${activeId}`, { method: 'DELETE' });
      const data = await readApiJson<{ error?: string }>(res, '删除数据库实例失败');
      if (!res.ok) {
        throw new Error(getApiErrorMessage(data, '删除数据库实例失败'));
      }
      await fetchInstances();
      resetEditorState('overview');
      showToast('数据库实例已删除');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除数据库实例失败', 'error');
    }
  };

  const handleOpenDetail = () => {
    if (!activeInstance) return;
    setPanelMode('detail');
  };

  const handleRunQuery = async () => {
    if (!activeId) return;
    if (!queryText.trim()) {
      showToast('请输入查询语句', 'error');
      return;
    }

    setQueryLoading(true);
    try {
      const res = await fetch(`/api/database-instances/${activeId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryText }),
      });
      const data = await readApiJson<DatabaseQueryPayload & { error?: string }>(res, '执行查询失败');
        if (!res.ok) {
          throw new Error(getApiErrorMessage(data, '执行查询失败'));
        }
        setQueryResult(data);
        showToast('查询执行完成');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '执行查询失败', 'error');
      setQueryResult(null);
    } finally {
      setQueryLoading(false);
    }
  };

  const validationBadgeClass = isValidationFresh
    ? `${styles.statusBadge} ${styles.success}`
    : (validationState === 'error' && validatedSignature === payloadSignature
      ? `${styles.statusBadge} ${styles.error}`
      : `${styles.statusBadge} ${styles.pending}`);

  return (
    <div className={styles.workspace}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarEyebrow}>
            <Icons.Database size={14} /> Data Studio
          </div>
          <div className={styles.sidebarTitle}>
            <div className={styles.sidebarTitleText}>
              <strong>数据库实例</strong>
              <span>统一管理 MySQL / PostgreSQL / Redis 实例，先验证连接，再浏览结构与查询数据。</span>
            </div>
            <button className="btn btn-primary btn-icon" onClick={handleCreateNew} title="新增数据库实例">
              <Icons.Plus size={18} />
            </button>
          </div>
          <div className={styles.badgeRow}>
            <span className={styles.softBadge}>{instances.length} 个实例</span>
            <span className={styles.softBadge}>MySQL {engineCounts.mysql}</span>
            <span className={styles.softBadge}>PgSQL {engineCounts.pgsql}</span>
            <span className={styles.softBadge}>Redis {engineCounts.redis}</span>
          </div>
        </div>

        <div className={styles.profileList}>
          {loading ? (
            <div className={styles.emptyState}>
              <Icons.Activity size={36} />
              <strong>正在读取数据库实例</strong>
              <span>请稍候，马上完成。</span>
            </div>
          ) : instances.length === 0 ? (
            <div className={styles.emptyState}>
              <Icons.Database size={40} />
              <strong>先添加第一个数据库实例</strong>
              <span>保存后即可查看表结构、预览数据，并在页面内执行只读查询。</span>
            </div>
          ) : (
            instances.map((instance) => (
              <button
                key={instance.id}
                type="button"
                className={`${styles.instanceCard} ${panelMode === 'edit' && activeId === instance.id ? styles.active : ''}`}
                onClick={() => handleSelectInstance(instance)}
              >
                <div className={styles.instanceTypeRow}>
                  <span className={`${styles.typeBadge} ${styles[instance.type]}`}>{instance.type.toUpperCase()}</span>
                </div>
                <div className={styles.instanceName}>{instance.name}</div>
                <div className={styles.instanceUri}>{maskConnectionUri(instance.connectionUri, instance.type)}</div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className={styles.main}>
        {panelMode === 'overview' && (
          <div className={styles.hero}>
            <div>
              <div className={styles.heroTitle}>把数据库连接、结构浏览和只读查询集中到一个工作台里。</div>
              <div className={styles.heroDesc}>
                数据库实例管理页面向日常联调和排障场景：先配置实例并验证连接，再直接查看表 / Key 信息、预览数据，并在页内执行只读 SQL 或 Redis 查询。
              </div>
              <div className={styles.heroMeta}>
                <span className={styles.softBadge}><Icons.Check size={12} /> 保存前强制连接验证</span>
                <span className={styles.softBadge}><Icons.Layers size={12} /> 支持结构浏览与数据预览</span>
                <span className={styles.softBadge}><Icons.Code size={12} /> 支持页内只读查询</span>
              </div>
            </div>
            <div className={styles.statGrid}>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>实例总数</div>
                <div className={styles.statValue}>{instances.length}</div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>MySQL</div>
                <div className={styles.statValue}>{engineCounts.mysql}</div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>PostgreSQL</div>
                <div className={styles.statValue}>{engineCounts.pgsql}</div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>Redis</div>
                <div className={styles.statValue}>{engineCounts.redis}</div>
              </div>
            </div>
          </div>
        )}

        <div className={styles.panel}>
          {panelMode === 'overview' ? (
            <>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>
                  <strong>实例总览</strong>
                  <span>默认先展示全局概况；点击左侧实例进入详情，点击右上角 `+` 直接新增。</span>
                </div>
              </div>

              <div className={styles.panelBody}>
                <div className={styles.overviewGrid}>
                  <div className={styles.overviewCard}>
                    <div className={styles.overviewLabel}>推荐顺序</div>
                    <div className={styles.overviewValue}>新增实例 → 验证连接 → 浏览结构 → 执行查询</div>
                    <div className={styles.inlineHint}>连接验证通过后才允许保存，避免把失效连接写进系统。</div>
                  </div>
                  <div className={styles.overviewCard}>
                    <div className={styles.overviewLabel}>支持连接示例</div>
                    <div className={styles.inlineHint}>
                      MySQL：{getConnectionPlaceholder('mysql')}
                      <br />
                      PgSQL：{getConnectionPlaceholder('pgsql')}
                      <br />
                      Redis：{getConnectionPlaceholder('redis')}
                    </div>
                  </div>
                  <div className={styles.overviewCard}>
                    <div className={styles.overviewLabel}>查询约束</div>
                    <div className={styles.inlineHint}>
                      SQL 仅支持只读语句，Redis 仅支持只读命令，适合日常排查与数据核对。
                    </div>
                  </div>
                </div>

                <div className={styles.footerMainActions}>
                  <button className="btn btn-primary" type="button" onClick={handleCreateNew}>
                    <Icons.Plus size={16} /> 新建数据库实例
                  </button>
                </div>
              </div>
            </>
          ) : panelMode === 'detail' && activeInstance ? (
            <>
              <div className={styles.panelHeader}>
                  <div className={styles.panelTitle}>
                    <strong>实例详情</strong>
                    <span>查看结构对象并直接执行只读查询，适合日常联调、排障和结果核对。</span>
                  </div>
                <div className={styles.badgeRow}>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => unsavedGuard.confirmAction(() => setPanelMode('edit'))}>
                    <Icons.ChevronRight size={14} /> 返回编辑
                  </button>
                  <span className={`${styles.typeBadge} ${styles[activeInstance.type]}`}>{activeInstance.type.toUpperCase()}</span>
                  <span className={styles.softBadge}>{maskConnectionUri(activeInstance.connectionUri, activeInstance.type)}</span>
                </div>
              </div>

              <div className={styles.detailHero}>
                  <div className={styles.detailMetaCard}>
                    <div className={styles.overviewLabel}>实例名称</div>
                    <div className={styles.detailPrimary}>{activeInstance.name}</div>
                    <div className={styles.inlineHint}>用于页面内浏览结构和执行只读查询。</div>
                  </div>
                <div className={styles.detailMetaCard}>
                  <div className={styles.overviewLabel}>连接信息</div>
                  <div className={styles.detailPrimaryMono}>{maskConnectionUri(activeInstance.connectionUri, activeInstance.type)}</div>
                  <div className={styles.inlineHint}>列表和详情头部默认脱敏显示，编辑时仍可修改原始值。</div>
                </div>
                <div className={styles.detailMetaCard}>
                  <div className={styles.overviewLabel}>已选对象</div>
                  <div className={styles.detailPrimary}>{selectedCollection || '待选择'}</div>
                  <div className={styles.inlineHint}>{activeInstance.type === 'redis' ? 'Redis 实例仅保留只读查询控制台，可直接输入命令执行。' : '从左侧选择一张表查看字段属性和样例数据。'}</div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>
                  <strong>{panelMode === 'edit' ? '编辑数据库实例' : '新建数据库实例'}</strong>
                  <span>沿用现有 Studio 风格工作台，连接信息变更后需要重新验证才能保存。</span>
                </div>
                <div className={styles.badgeRow}>
                  <span className={styles.softBadge}>{draft.type.toUpperCase()}</span>
                  <span className={styles.softBadge}>{maskConnectionUri(draft.connectionUri, draft.type)}</span>
                </div>
              </div>

              <div className={styles.panelBody}>
                {detailLoading ? (
                  <div className={styles.emptyState} style={{ padding: '120px 0' }}>
                    <Icons.Activity size={32} className="spin" />
                    <span style={{ marginTop: 16 }}>正在读取数据库实例详情...</span>
                  </div>
                ) : (
                  <>
                    <div className={styles.formGrid}>
                  <label className={styles.formSpan2}>
                    <div className="form-label">实例名称</div>
                    <input
                      className="form-input"
                      value={draft.name}
                      placeholder="例如：本地 MySQL / 客服中心 PgSQL / 本地 Redis"
                      onChange={(e) => updateDraft('name', e.target.value)}
                    />
                  </label>

                  <div className={styles.formSpan2}>
                    <div className="form-label">实例类型</div>
                    <div className={styles.segmented}>
                      {([
                        ['mysql', 'MySQL'],
                        ['pgsql', 'PostgreSQL'],
                        ['redis', 'Redis'],
                      ] as Array<[DatabaseInstanceType, string]>).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={draft.type === value ? styles.active : ''}
                          onClick={() => updateDraft('type', value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className={styles.formSpan2}>
                    <div className="form-label">连接地址</div>
                    <input
                      className="form-input"
                      value={draft.connectionUri}
                      placeholder={getConnectionPlaceholder(draft.type)}
                      onChange={(e) => updateDraft('connectionUri', e.target.value)}
                    />
                    <div className={styles.inlineHint} style={{ marginTop: 8 }}>
                      {getConnectionExample(draft.type)}
                    </div>
                  </label>

                  {draft.type !== 'redis' && (
                    <>
                      <label>
                        <div className="form-label">用户名</div>
                        <input
                          className="form-input"
                          value={draft.username}
                          placeholder="root"
                          onChange={(e) => updateDraft('username', e.target.value)}
                        />
                      </label>
                      <label>
                        <div className="form-label">密码</div>
                      <input
                        className="form-input"
                        type={showPassword ? 'text' : 'password'}
                        value={draft.password}
                        placeholder="root"
                        onChange={(e) => updateDraft('password', e.target.value)}
                      />
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowPassword((prev) => !prev)}>
                        {showPassword ? '隐藏密码' : '显示密码'}
                      </button>
                    </label>
                  </>
                  )}

                  {draft.type === 'redis' && (
                    <label className={styles.formSpan2}>
                      <div className="form-label">Redis 密码（可选）</div>
                      <input
                        className="form-input"
                        type={showPassword ? 'text' : 'password'}
                        value={draft.password}
                        placeholder="无鉴权可留空"
                        onChange={(e) => updateDraft('password', e.target.value)}
                      />
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowPassword((prev) => !prev)}>
                        {showPassword ? '隐藏密码' : '显示密码'}
                      </button>
                    </label>
                  )}
                </div>

                <div className={styles.validationCard}>
                  <div className={styles.sectionTitle}>
                    <div>
                      <strong>连接验证</strong>
                      <span>新增或修改连接信息后，需要重新验证通过才能保存。</span>
                    </div>
                    <span className={validationBadgeClass}>
                      {isValidationFresh
                        ? '已通过'
                        : (validationState === 'error' && validatedSignature === payloadSignature ? '未通过' : '待验证')}
                    </span>
                  </div>
                  <div className={styles.validationBox}>
                    <div className={styles.validationMessage}>{validationMessage}</div>
                    <button className="btn btn-secondary" type="button" onClick={handleTestConnection} disabled={testing}>
                      <Icons.Activity size={16} />
                      {testing ? '验证中...' : '测试连接'}
                    </button>
                  </div>
                </div>

                <div className={styles.footerActions}>
                  <div className={styles.footerMainActions}>
                    <button className="btn btn-primary" type="button" onClick={handleSave} disabled={saving || testing || !isValidationFresh}>
                      <Icons.Check size={16} />
                      {saving ? '保存中...' : (panelMode === 'edit' ? '保存更新' : '创建实例')}
                    </button>
                    <button className="btn btn-secondary" type="button" onClick={() => unsavedGuard.confirmAction(() => resetEditorState('overview'))}>
                      <Icons.ChevronRight size={16} /> 返回总览
                    </button>
                    {panelMode === 'edit' && activeId && (
                      <button className="btn btn-secondary" type="button" onClick={handleOpenDetail}>
                        <Icons.Database size={16} /> 实例详情
                      </button>
                    )}
                  </div>

                  {panelMode === 'edit' && activeId && (
                    <button className="btn btn-danger-ghost" type="button" onClick={handleDelete}>
                      <Icons.Trash size={16} /> 删除当前实例
                    </button>
                  )}
                </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {panelMode === 'detail' && activeInstance && (
          <div className={activeInstance.type === 'redis' ? styles.consoleOnly : styles.explorerGrid}>
            {activeInstance.type !== 'redis' && (
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelTitle}>
                    <strong>结构浏览</strong>
                    <span>查看表与字段结构</span>
                  </div>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => void loadSchema(activeInstance.id)} disabled={schemaLoading}>
                    <Icons.Refresh size={14} /> {schemaLoading ? '刷新中...' : '刷新结构'}
                  </button>
                </div>
                <div className={`${styles.panelBody} ${styles.schemaBody}`}>
                  {schemaLoading ? (
                    <div className={styles.inlineHint}>正在读取结构信息...</div>
                  ) : !schemaData || schemaData.collections.length === 0 ? (
                    <div className={styles.emptyStateCompact}>
                      <strong>还没有读取到结构数据</strong>
                      <span>请确认实例内已有表，并尝试刷新结构。</span>
                    </div>
                  ) : (
                    <div className={styles.collectionList}>
                      {schemaData.collections.map((collection: DatabaseCollectionInfo) => (
                        <button
                          key={collection.name}
                          type="button"
                          className={`${styles.collectionItem} ${selectedCollection === collection.name ? styles.selected : ''}`}
                          onClick={() => {
                            setSelectedCollection(collection.name);
                            setIsStructureCollapsed(false);
                            setQueryText(getDefaultQuery(activeInstance.type, collection.name));
                            setQueryResult(null);
                          }}
                        >
                          <div className={styles.collectionName}>{collection.name}</div>
                          <div className={styles.collectionDetail}>{`${collection.columns?.length || 0} 个字段`}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className={styles.consoleStack}>
              {activeInstance.type !== 'redis' && (
                <div className={styles.panel}>
                  <div className={styles.panelHeader}>
                    <div className={styles.panelTitle}>
                      <strong>表结构属性</strong>
                      <span>{`${getStructurePanelSubtitle(activeInstance.type, selectedCollectionInfo, selectedCollection)}${selectedMetricTotal ? ` · 已映射 ${selectedMetricCount}/${selectedMetricTotal} 个字段` : ''}`}</span>
                    </div>
                    <div className={styles.panelHeaderActions}>
                      {selectedCollectionInfo?.category === 'table' && selectedMetricTotal > 0 && (
                        <button
                          className="btn btn-primary btn-sm"
                          type="button"
                          onClick={() => {
                            if (!activeInstance || !selectedCollectionInfo) return;
                            const nextHref = `/database-instances/metrics?instanceId=${activeInstance.id}&collection=${encodeURIComponent(selectedCollectionInfo.name)}`;
                            unsavedGuard.confirmNavigation(nextHref, () => {
                              router.push(nextHref);
                            });
                          }}
                        >
                          <Icons.Activity size={14} /> 语义配置
                        </button>
                      )}
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => setIsStructureCollapsed((prev) => !prev)}
                        aria-expanded={!isStructureCollapsed}
                      >
                        <Icons.ChevronRight
                          size={14}
                          style={{ transform: isStructureCollapsed ? 'rotate(90deg)' : 'rotate(-90deg)' }}
                        />
                        {isStructureCollapsed ? '展开' : '折叠'}
                      </button>
                    </div>
                  </div>
                  {!isStructureCollapsed && (
                    <div className={styles.panelBody}>
                      {selectedCollectionInfo?.category === 'table' && selectedCollectionInfo.columns && selectedCollectionInfo.columns.length > 0 ? (
                        <>
                          <div className={styles.structureFilterBar}>
                            <label className={styles.structureFilterGroup}>
                              <span>语义筛选</span>
                              <select
                                className="form-select"
                                value={fieldSemanticFilter}
                                onChange={(event) => setFieldSemanticFilter(event.target.value as FieldSemanticFilter)}
                              >
                                <option value="all">全部字段</option>
                                <option value="metric">度量</option>
                                <option value="dimension">维度</option>
                                <option value="time">时间</option>
                                <option value="identifier">标识</option>
                                <option value="attribute">属性</option>
                              </select>
                            </label>
                            <label className={styles.structureToggle}>
                              <input
                                type="checkbox"
                                checked={mappedOnly}
                                onChange={(event) => setMappedOnly(event.target.checked)}
                              />
                              <span>只看已映射字段</span>
                            </label>
                            <label className={styles.structureToggle}>
                              <input
                                type="checkbox"
                                checked={relatedOnly}
                                onChange={(event) => setRelatedOnly(event.target.checked)}
                              />
                              <span>只看有关联字段</span>
                            </label>
                            <div className={styles.structureFilterMeta}>
                              当前展示 {filteredColumns.length} / {selectedCollectionInfo.columns.length} 个字段
                            </div>
                          </div>

                          <div className={styles.tableShell}>
                          <table className={styles.dataTable}>
                            <thead>
                              <tr>
                                <th>字段名</th>
                                <th>类型</th>
                                <th>结构属性</th>
                                <th>目录关系</th>
                                <th>语义映射</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredColumns.map((column) => {
                                const metric = selectedMetricMappings[column.name];
                                const relationText = column.referencesTable
                                  ? `${column.referencesTable}.${column.referencesColumn || 'id'}`
                                  : '无外键关联';
                                const semanticRole = inferFieldSemanticRole(column, metric);

                                return (
                                  <tr key={column.name}>
                                    <td><pre>{column.name}</pre></td>
                                    <td><pre>{column.type}</pre></td>
                                    <td>
                                      <div className={styles.cellStack}>
                                        <div className={styles.cellLine}>可空：{column.nullable ? 'YES' : 'NO'}</div>
                                        <div className={styles.cellLine}>默认值：{column.defaultValue ?? '-'}</div>
                                        <div className={styles.cellLine}>主键：{column.isPrimary ? 'YES' : '-'}</div>
                                        <div className={styles.cellLine}>附加：{column.extra || '-'}</div>
                                        <div className={styles.cellLine}>备注：{column.comment || '-'}</div>
                                      </div>
                                    </td>
                                    <td>
                                      <div className={styles.cellStack}>
                                        <div className={styles.cellLine}>关系：{relationText}</div>
                                        <div className={styles.cellLine}>实体：{selectedCollectionInfo.name}</div>
                                      </div>
                                    </td>
                                    <td>
                                      {metric ? (
                                        <div className={styles.cellStack}>
                                          <div className={styles.cellLine}>角色：{semanticRole}</div>
                                          <div className={styles.cellLine}>业务名：{metric.metricName || '-'}</div>
                                          <div className={styles.cellLine}>别名：{formatMetricAliases(metric.aliases)}</div>
                                          <div className={styles.cellLine}>类型：{metric.metricType || '-'}</div>
                                          <div className={styles.cellLine}>计算：{metric.calcMode || '-'}</div>
                                          <div className={styles.cellLine}>NER：{metric.enableForNer ? '启用' : '关闭'}</div>
                                          <div className={styles.cellLine}>描述：{metric.description || '-'}</div>
                                        </div>
                                      ) : (
                                        <div className={styles.cellStack}>
                                          <div className={styles.cellLine}>角色：{semanticRole}</div>
                                          <div className={styles.cellMuted}>未配置语义映射</div>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          </div>
                          {filteredColumns.length === 0 ? (
                            <div className={styles.inlineHint}>当前筛选条件下没有字段，请放宽语义或关联条件。</div>
                          ) : null}
                        </>
                      ) : (
                        <div className={styles.emptyStateCompact}>
                          <strong>当前对象没有可展示的字段属性</strong>
                          <span>请先从左侧选择一张表。</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelTitle}>
                    <strong>查询控制台</strong>
                    <span>{selectedCollection ? `当前对象：${selectedCollection} · ${getQueryHint(activeInstance.type)}` : getQueryHint(activeInstance.type)}</span>
                  </div>
                  <button className="btn btn-primary btn-sm" type="button" onClick={handleRunQuery} disabled={queryLoading}>
                    <Icons.Send size={14} /> {queryLoading ? '执行中...' : '执行查询'}
                  </button>
                </div>
                <div className={styles.panelBody}>
                  <textarea
                    className={styles.queryEditor}
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    spellCheck={false}
                    placeholder={getDefaultQuery(activeInstance.type)}
                  />

                  {queryResult ? (
                    <>
                      {queryResult.summary && <div className={styles.inlineHint}>{queryResult.summary}</div>}
                      {queryResult.columns.length > 0 ? (
                        <div className={styles.tableShell}>
                          <table className={styles.dataTable}>
                            <thead>
                              <tr>
                                {queryResult.columns.map((column) => (
                                  <th key={column}>{column}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {queryResult.rows.length > 0 ? queryResult.rows.map((row, index) => (
                                <tr key={`query-row-${index}`}>
                                  {queryResult.columns.map((column) => (
                                    <td key={column}>
                                      <pre>{renderCellValue(row[column])}</pre>
                                    </td>
                                  ))}
                                </tr>
                              )) : (
                                <tr>
                                  <td colSpan={Math.max(queryResult.columns.length, 1)}>
                                    <div className={styles.inlineHint}>查询执行成功，但没有返回结果。</div>
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className={styles.emptyStateCompact}>
                          <strong>查询已执行</strong>
                          <span>当前语句没有返回结构化字段结果，请查看上方提示文案确认执行情况。</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className={styles.emptyStateCompact}>
                      <strong>还没有执行查询</strong>
                      <span>可以先点左侧某个表 / Key 自动填充查询模板，再执行只读查询。</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {toast && <div className={`${styles.toast} ${toast.type === 'error' ? styles.error : ''}`}>{toast.message}</div>}

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

export default function DatabaseInstancesPage() {
  return (
    <Suspense fallback={null}>
      <DatabaseInstancesPageContent />
    </Suspense>
  );
}

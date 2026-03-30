'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog';
import { sanitizeDatabaseMetricMappings } from '@/lib/database-instances';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import {
  DatabaseCollectionInfo,
  DatabaseFieldMetricMapping,
  DatabaseInstance,
  DatabaseMetricMappings,
  DatabaseSchemaPayload,
  DatabaseTableMetricMapping,
} from '@/lib/types';
import { Icons } from '@/components/Icons';
import styles from './page.module.css';

function getApiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }
  return fallback;
}

async function readApiJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok) {
      throw new Error(fallback);
    }
    throw new Error('接口返回格式异常，请稍后重试');
  }
}

export default function DatabaseMetricConfigPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const instanceId = searchParams.get('instanceId');
  const initialCollection = searchParams.get('collection');

  const [instance, setInstance] = useState<DatabaseInstance | null>(null);
  const [schema, setSchema] = useState<DatabaseSchemaPayload | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(initialCollection);
  const [metricMappings, setMetricMappings] = useState<DatabaseMetricMappings>({});
  const [baseline, setBaseline] = useState('{}');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const tableCollections = useMemo(
    () => (schema?.collections || []).filter((item) => item.category === 'table'),
    [schema]
  );
  const selectedInfo = useMemo<DatabaseCollectionInfo | null>(
    () => tableCollections.find((item) => item.name === selectedCollection) || null,
    [selectedCollection, tableCollections]
  );
  const sanitizedMappings = useMemo(
    () => sanitizeDatabaseMetricMappings(metricMappings),
    [metricMappings]
  );
  const selectedTableMapping = useMemo<DatabaseTableMetricMapping | null>(
    () => (selectedCollection ? sanitizedMappings[selectedCollection] || null : null),
    [sanitizedMappings, selectedCollection]
  );
  const selectedMetricMappings = useMemo(
    () => selectedTableMapping?.fields || {},
    [selectedTableMapping]
  );
  const selectedTableDescription = selectedTableMapping?.description || '';
  const metricSignature = useMemo(() => JSON.stringify(sanitizedMappings), [sanitizedMappings]);
  const isDirty = metricSignature !== baseline;
  const selectedMetricCount = useMemo(
    () => Object.keys(selectedMetricMappings).length,
    [selectedMetricMappings]
  );
  const hasSelectedTableConfig = Boolean(selectedTableDescription || selectedMetricCount > 0);
  const totalMetricCount = useMemo(
    () => Object.values(sanitizedMappings).reduce((sum, mapping) => sum + Object.keys(mapping.fields || {}).length, 0),
    [sanitizedMappings]
  );

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!instanceId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const [instanceResponse, schemaResponse] = await Promise.all([
          fetch(`/api/database-instances/${instanceId}`),
          fetch(`/api/database-instances/${instanceId}/schema`),
        ]);

        const instancePayload = await readApiJson<DatabaseInstance & { error?: string }>(instanceResponse, '读取数据库实例失败');
        if (!instanceResponse.ok) {
          throw new Error(getApiErrorMessage(instancePayload, '读取数据库实例失败'));
        }

        const schemaPayload = await readApiJson<DatabaseSchemaPayload & { error?: string }>(schemaResponse, '读取数据库结构失败');
        if (!schemaResponse.ok) {
          throw new Error(getApiErrorMessage(schemaPayload, '读取数据库结构失败'));
        }

        if (cancelled) return;

        const nextInstance = instancePayload as DatabaseInstance;
        const nextMappings = sanitizeDatabaseMetricMappings(nextInstance.metricMappings || {});
        const nextSchema = schemaPayload as DatabaseSchemaPayload;
        const nextTables = nextSchema.collections.filter((item) => item.category === 'table');
        const nextSelectedCollection =
          (initialCollection && nextTables.some((item) => item.name === initialCollection) ? initialCollection : null)
          || nextTables[0]?.name
          || null;

        setInstance(nextInstance);
        setSchema(nextSchema);
        setMetricMappings(nextMappings);
        setBaseline(JSON.stringify(nextMappings));
        setSelectedCollection(nextSelectedCollection);
      } catch (error) {
        if (!cancelled) {
          showToast(error instanceof Error ? error.message : '读取指标配置失败', 'error');
          setInstance(null);
          setSchema(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialCollection, instanceId, showToast]);

  const updateColumnMetricMapping = useCallback((
    tableName: string,
    columnName: string,
    key: keyof DatabaseFieldMetricMapping,
    value: string
  ) => {
    setMetricMappings((prev) => {
      const next = { ...prev };
      const tableMapping: DatabaseTableMetricMapping = {
        ...(next[tableName] || { fields: {} }),
        fields: { ...(next[tableName]?.fields || {}) },
      };
      const fieldMapping = { ...(tableMapping.fields[columnName] || {}) } as Record<string, string>;

      if (value) {
        fieldMapping[key] = value;
      } else {
        delete fieldMapping[key];
      }

      if (Object.keys(fieldMapping).length > 0) {
        tableMapping.fields[columnName] = fieldMapping as DatabaseFieldMetricMapping;
      } else {
        delete tableMapping.fields[columnName];
      }

      if (tableMapping.description || Object.keys(tableMapping.fields).length > 0) {
        next[tableName] = tableMapping;
      } else {
        delete next[tableName];
      }

      return next;
    });
  }, []);

  const handleTableDescriptionChange = useCallback((tableName: string, value: string) => {
    setMetricMappings((prev) => {
      const next = { ...prev };
      const tableMapping: DatabaseTableMetricMapping = {
        ...(next[tableName] || { fields: {} }),
        fields: { ...(next[tableName]?.fields || {}) },
      };
      const nextDescription = value.trim();

      if (nextDescription) {
        tableMapping.description = nextDescription;
      } else {
        delete tableMapping.description;
      }

      if (tableMapping.description || Object.keys(tableMapping.fields).length > 0) {
        next[tableName] = tableMapping;
      } else {
        delete next[tableName];
      }

      return next;
    });
  }, []);

  const handleSelectCollection = useCallback((collectionName: string) => {
    setSelectedCollection(collectionName);
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('collection', collectionName);
    router.replace(`/database-instances/metrics?${nextParams.toString()}`);
  }, [router, searchParams]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!instanceId || !instance || instance.type === 'redis') return false;

    setSaving(true);
    try {
      const response = await fetch(`/api/database-instances/${instanceId}/metric-mappings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metricMappings: sanitizedMappings }),
      });
      const payload = await readApiJson<DatabaseInstance & { error?: string }>(response, '保存指标映射失败');
      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, '保存指标映射失败'));
      }

      const nextInstance = payload as DatabaseInstance;
      const nextMappings = sanitizeDatabaseMetricMappings(nextInstance.metricMappings || {});
      setInstance(nextInstance);
      setMetricMappings(nextMappings);
      setBaseline(JSON.stringify(nextMappings));
      showToast('指标映射已保存');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存指标映射失败', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [instance, instanceId, sanitizedMappings, showToast]);

  const handleSave = useCallback(() => {
    void saveCurrent();
  }, [saveCurrent]);

  const unsavedGuard = useUnsavedChangesGuard({
    enabled: true,
    isDirty,
    onSave: saveCurrent,
  });

  const handleResetSelectedTable = useCallback(() => {
    if (!selectedCollection) return;
    setMetricMappings((prev) => {
      const next = { ...prev };
      delete next[selectedCollection];
      return next;
    });
  }, [selectedCollection]);

  if (!instanceId) {
    return (
      <div className={styles.emptyPage}>
        <Icons.AlertTriangle size={24} />
        <strong>缺少数据库实例参数</strong>
        <span>请从数据库实例详情页进入指标配置页。</span>
        <Link href="/database-instances" className="btn btn-primary">返回数据库实例</Link>
      </div>
    );
  }

  const backHref = '/database-instances';
  const detailHref = `/database-instances?detail=${encodeURIComponent(instanceId)}${selectedCollection ? `&collection=${encodeURIComponent(selectedCollection)}` : ''}`;

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <div className={styles.heroEyebrow}>
            <Icons.Activity size={14} />
            Metric Studio
          </div>
          <div className={styles.heroTitle}>指标配置</div>
          <div className={styles.heroDesc}>
            把数据库原始字段补充成可理解的业务指标。这里专门负责维护指标名称、描述、类型与计算模式，让数据库实例详情页重新回到结构浏览本身。
          </div>
          <div className={styles.heroMeta}>
            <span className={styles.metaBadge}><Icons.Database size={12} /> {instance?.name || '读取实例中'}</span>
            <span className={styles.metaBadge}><Icons.Layers size={12} /> {tableCollections.length} 张表</span>
            <span className={styles.metaBadge}><Icons.Check size={12} /> 已配置 {totalMetricCount} 个字段</span>
          </div>
        </div>

        <div className={styles.heroActions}>
          <div className={styles.heroActionTop}>
            <strong>当前配置焦点</strong>
            <span>{selectedInfo ? `${selectedInfo.name} · ${selectedMetricCount}/${selectedInfo.columns?.length || 0} 字段已补充` : '请选择左侧库表'}</span>
          </div>
          <div className={styles.heroActionButtons}>
            <button className="btn btn-secondary" type="button" onClick={() => unsavedGuard.confirmAction(() => router.push(detailHref))}>
              <Icons.ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} /> 返回上一页
            </button>
            <Link href={backHref} className="btn btn-secondary">
              <Icons.Database size={16} /> 数据库实例
            </Link>
            <button className="btn btn-primary" type="button" onClick={handleSave} disabled={saving || !isDirty}>
              <Icons.Check size={16} /> {saving ? '保存中...' : '保存指标配置'}
            </button>
          </div>
        </div>
      </section>

      <section className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div>
              <strong>表列表</strong>
              <span>切换需要配置指标的数据库表。</span>
            </div>
          </div>
          <div className={styles.schemaList}>
            {tableCollections.map((collection) => {
              const count = Object.keys(sanitizedMappings[collection.name] || {}).length;
              return (
                <button
                  key={collection.name}
                  type="button"
                  className={`${styles.schemaCard} ${selectedCollection === collection.name ? styles.active : ''}`}
                  onClick={() => unsavedGuard.confirmAction(() => handleSelectCollection(collection.name))}
                >
                  <div className={styles.schemaCardTop}>
                    <strong>{collection.name}</strong>
                    <span className={styles.schemaCount}>{collection.columns?.length || 0} 字段</span>
                  </div>
                  <div className={styles.schemaCardMeta}>
                    <span>{count} 个字段已配置</span>
                    <span>{count > 0 ? '可继续完善' : '等待配置'}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className={styles.main}>
          {loading ? (
            <div className={styles.emptyPage}>
              <Icons.Refresh size={22} />
              <strong>正在读取指标配置</strong>
              <span>正在加载实例详情与表结构，请稍候。</span>
            </div>
          ) : !instance || instance.type === 'redis' ? (
            <div className={styles.emptyPage}>
              <Icons.AlertTriangle size={24} />
              <strong>当前实例不支持指标配置</strong>
              <span>只有 MySQL 与 PostgreSQL 实例支持字段级指标映射。</span>
            </div>
          ) : !selectedInfo ? (
            <div className={styles.emptyPage}>
              <Icons.Layers size={24} />
              <strong>请选择一个数据库表</strong>
              <span>左侧库表列表用于切换当前正在配置的指标对象。</span>
            </div>
          ) : (
            <>
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelTitle}>
                    <strong>配置概览</strong>
                    <span>{selectedInfo.name} · {selectedMetricCount}/{selectedInfo.columns?.length || 0} 字段已配置</span>
                  </div>
                  <div className={styles.panelHeaderMeta}>
                    <div className={styles.badgeRow}>
                      <span className={styles.metricBadge}>实例：{instance.name}</span>
                      <span className={styles.metricBadge}>引擎：{instance.type.toUpperCase()}</span>
                      {isDirty && <span className={styles.metricBadgePending}>存在未保存修改</span>}
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={handleResetSelectedTable}
                      disabled={!hasSelectedTableConfig}
                    >
                      <Icons.X size={14} /> 清空该表配置
                    </button>
                  </div>
                </div>
                <div className={styles.panelBody}>
                  <div className={styles.metricStudioHeader}>
                    <div>
                      <strong>字段语义补充</strong>
                      <span>把字段技术属性翻译成业务指标语义，后续更适合下游 DB API、调试和分析配置复用。</span>
                    </div>
                    <div className={styles.metricLegend}>
                      <span className={styles.metricLegendItem}>字段属性</span>
                      <span className={styles.metricLegendItem}>业务语义</span>
                      <span className={styles.metricLegendItem}>计算规则</span>
                    </div>
                  </div>
                  <label className={styles.tableDescriptionField}>
                    <span>整表补充说明</span>
                    <textarea
                      className={`form-input ${styles.tableDescriptionInput}`}
                      value={selectedTableDescription}
                      onChange={(event) => handleTableDescriptionChange(selectedInfo.name, event.target.value)}
                      placeholder="补充整张表的业务用途、统计口径、边界说明或使用注意事项，这部分会与字段指标一起保存。"
                    />
                  </label>
                </div>
              </div>

              <div className={styles.metricRowList}>
                {selectedInfo.columns?.map((column) => {
                  const mapping = selectedMetricMappings[column.name] || {};
                  const isMapped = Object.keys(mapping).length > 0;

                  return (
                    <section key={column.name} className={`${styles.metricRow} ${isMapped ? styles.metricRowActive : ''}`}>
                      <div className={styles.metricRowIdentity}>
                        <div className={styles.metricFieldTitle}>
                          <div className={styles.metricFieldNameRow}>
                            <code>{column.name}</code>
                            <span className={styles.metricFieldType}>{column.type}</span>
                            {column.isPrimary && <span className={styles.metricFieldPrimary}>主键</span>}
                            {isMapped && <span className={styles.metricFieldMapped}>已配置</span>}
                          </div>
                          <div className={styles.metricFieldMeta}>
                            <span>{column.nullable ? '允许空值' : '必填字段'}</span>
                            <span>默认值：{column.defaultValue ?? '-'}</span>
                            <span>附加属性：{column.extra || '-'}</span>
                          </div>
                        </div>
                      </div>

                      <div className={styles.metricRowFields}>
                        <label className={styles.metricFormField}>
                          <span>指标名称</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={mapping.metricName || ''}
                            onChange={(event) => updateColumnMetricMapping(selectedInfo.name, column.name, 'metricName', event.target.value)}
                            placeholder="例如：订单金额 / 会话ID / 模型名称"
                          />
                        </label>

                        <label className={styles.metricFormField}>
                          <span>指标描述</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={mapping.description || ''}
                            onChange={(event) => updateColumnMetricMapping(selectedInfo.name, column.name, 'description', event.target.value)}
                            placeholder="补充该字段在业务分析、调试或报表中的具体含义"
                          />
                        </label>

                        <label className={styles.metricFormField}>
                          <span>指标类型</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={mapping.metricType || ''}
                            onChange={(event) => updateColumnMetricMapping(selectedInfo.name, column.name, 'metricType', event.target.value)}
                            placeholder="例如：维度 / 度量 / 标识 / 时间"
                          />
                        </label>

                        <label className={styles.metricFormField}>
                          <span>指标计算模式</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={mapping.calcMode || ''}
                            onChange={(event) => updateColumnMetricMapping(selectedInfo.name, column.name, 'calcMode', event.target.value)}
                            placeholder="例如：原值 / 求和 / 平均 / 去重计数"
                          />
                        </label>
                      </div>
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </main>
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

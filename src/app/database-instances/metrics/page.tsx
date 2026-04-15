'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog';
import { getAIModelSelectionKey } from '@/lib/ai-models';
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { isDateLikeType, isNumericType, isTextLikeType } from '@/lib/db-harness/core/utils';
import {
  AIModelProfileSummary,
  DatabaseCollectionInfo,
  DatabaseFieldMetricMapping,
  DatabaseInstance,
  DatabaseSemanticModel,
  DatabaseSemanticModelEntity,
  DatabaseSemanticModelField,
  DatabaseSemanticRole,
  DatabaseSchemaPayload,
} from '@/lib/types';
import { Icons } from '@/components/Icons';
import styles from './page.module.css';

const SEMANTIC_ROLE_OPTIONS: Array<{ value: DatabaseSemanticRole; label: string }> = [
  { value: 'metric', label: '度量 / Metric' },
  { value: 'dimension', label: '维度 / Dimension' },
  { value: 'time', label: '时间 / Time' },
  { value: 'identifier', label: '标识 / Identifier' },
  { value: 'attribute', label: '属性 / Attribute' },
];

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

function buildEmptySemanticModel(): DatabaseSemanticModel {
  return {
    entityCount: 0,
    configuredFieldCount: 0,
    inferredFieldCount: 0,
    glossary: [],
    entities: [],
    source: 'generated',
  };
}

function isConfiguredSemanticField(field: DatabaseSemanticModelField | undefined): boolean {
  if (!field) return false;
  return field.derivedFrom !== 'schema'
    || field.enableForNer
    || field.aliases.length > 0
    || Boolean(field.description)
    || Boolean(field.metricType)
    || Boolean(field.calcMode);
}

function inferSemanticRole(
  column: NonNullable<DatabaseCollectionInfo['columns']>[number],
  mapping: DatabaseFieldMetricMapping | undefined
): DatabaseSemanticRole {
  const metricType = (mapping?.metricType || '').toLowerCase();
  const calcMode = (mapping?.calcMode || '').toLowerCase();
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

function rebuildSemanticEntity(entity: DatabaseSemanticModelEntity): DatabaseSemanticModelEntity {
  const dedupe = (values: string[], limit: number) => values
    .filter((item, index, array) => item && array.indexOf(item) === index)
    .slice(0, limit);

  return {
    ...entity,
    metrics: dedupe(entity.fields.filter((field) => field.semanticRole === 'metric').map((field) => field.metricName), 12),
    dimensions: dedupe(entity.fields.filter((field) => field.semanticRole === 'dimension').map((field) => field.metricName), 12),
    timeFields: dedupe(entity.fields.filter((field) => field.semanticRole === 'time').map((field) => field.metricName), 8),
    identifierFields: dedupe(entity.fields.filter((field) => field.semanticRole === 'identifier').map((field) => field.metricName), 8),
    nerEnabledFields: dedupe(entity.fields.filter((field) => field.enableForNer).map((field) => field.metricName), 16),
  };
}

function rebuildSemanticModel(model: DatabaseSemanticModel): DatabaseSemanticModel {
  const entities = model.entities.map((entity) => rebuildSemanticEntity(entity));
  const fields = entities.flatMap((entity) => entity.fields);
  const glossary = [...(model.glossary || []), ...fields.flatMap((field) => [field.metricName, ...(field.aliases || [])])]
    .map((item) => item.trim())
    .filter((item, index, array) => item && array.indexOf(item) === index)
    .slice(0, 160);

  return {
    ...model,
    entityCount: entities.length,
    configuredFieldCount: fields.filter((field) => isConfiguredSemanticField(field)).length,
    inferredFieldCount: fields.filter((field) => !isConfiguredSemanticField(field)).length,
    glossary,
    entities,
  };
}

interface SemanticGenerationModelSelection {
  profileId: string;
  profileName: string;
  modelId: string;
  isDefault: boolean;
}

function flattenSemanticGenerationSelections(profiles: AIModelProfileSummary[]): SemanticGenerationModelSelection[] {
  return profiles
    .filter((profile) => profile.modelType === 'chat')
    .flatMap((profile) => profile.modelIds.map((modelId) => ({
      profileId: profile.id,
      profileName: profile.name,
      modelId,
      isDefault: profile.isDefault && profile.defaultModelId === modelId,
    })));
}

function DatabaseSemanticConfigPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const instanceId = searchParams.get('instanceId');
  const initialCollection = searchParams.get('collection');

  const [instance, setInstance] = useState<DatabaseInstance | null>(null);
  const [schema, setSchema] = useState<DatabaseSchemaPayload | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(initialCollection);
  const [semanticModel, setSemanticModel] = useState<DatabaseSemanticModel>(buildEmptySemanticModel());
  const [semanticBaseline, setSemanticBaseline] = useState('{}');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingSemantic, setRefreshingSemantic] = useState(false);
  const [modelProfiles, setModelProfiles] = useState<AIModelProfileSummary[]>([]);
  const [modelProfilesLoading, setModelProfilesLoading] = useState(true);
  const [selectedGenerationModelKey, setSelectedGenerationModelKey] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const tableCollections = useMemo(
    () => (schema?.collections || []).filter((item) => item.category === 'table'),
    [schema]
  );
  const selectedInfo = useMemo<DatabaseCollectionInfo | null>(
    () => tableCollections.find((item) => item.name === selectedCollection) || null,
    [selectedCollection, tableCollections]
  );
  const seedMetricMappings = useMemo(
    () => getEffectiveDatabaseMetricMappings({
      metricMappings: instance?.metricMappings,
      semanticModel: instance?.semanticModel,
    }),
    [instance]
  );
  const sanitizedSemanticModel = useMemo(
    () => sanitizeDatabaseSemanticModel(semanticModel) || buildEmptySemanticModel(),
    [semanticModel]
  );
  const selectedSemanticEntity = useMemo<DatabaseSemanticModelEntity | null>(
    () => (selectedCollection ? sanitizedSemanticModel.entities.find((entity) => entity.table === selectedCollection) || null : null),
    [sanitizedSemanticModel.entities, selectedCollection]
  );
  const semanticSignature = useMemo(() => JSON.stringify(sanitizedSemanticModel), [sanitizedSemanticModel]);
  const isDirty = semanticSignature !== semanticBaseline;

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  }, []);

  const buildDefaultSemanticEntity = useCallback((tableName: string, baseEntity?: DatabaseSemanticModelEntity | null) => {
    const collection = tableCollections.find((item) => item.name === tableName);
    const fieldMap = new Map((baseEntity?.fields || []).map((field) => [field.column, field]));
    const tableMetricMapping = seedMetricMappings[tableName];

    const fields = (collection?.columns || []).map((column) => {
      const existing = fieldMap.get(column.name);
      if (existing) {
        return { ...existing, aliases: [...(existing.aliases || [])] };
      }

      const mapping = tableMetricMapping?.fields?.[column.name];
      return {
        table: tableName,
        column: column.name,
        metricName: mapping?.metricName || column.comment?.trim() || column.name,
        description: mapping?.description || column.comment?.trim() || '',
        metricType: mapping?.metricType,
        calcMode: mapping?.calcMode,
        enableForNer: mapping?.enableForNer === true,
        aliases: [...(mapping?.aliases || [])],
        semanticRole: inferSemanticRole(column, mapping),
        derivedFrom: mapping ? 'mapping' : 'schema',
      } satisfies DatabaseSemanticModelField;
    });

    return rebuildSemanticEntity({
      table: tableName,
      description: baseEntity?.description || tableMetricMapping?.description || '',
      metrics: [],
      dimensions: [],
      timeFields: [],
      identifierFields: [],
      nerEnabledFields: [],
      fields,
    });
  }, [seedMetricMappings, tableCollections]);

  const selectedSemanticDraftEntity = useMemo(
    () => (selectedInfo ? buildDefaultSemanticEntity(selectedInfo.name, selectedSemanticEntity) : null),
    [buildDefaultSemanticEntity, selectedInfo, selectedSemanticEntity]
  );
  const selectedSemanticFieldMap = useMemo<Record<string, DatabaseSemanticModelField>>(
    () => Object.fromEntries((selectedSemanticDraftEntity?.fields || []).map((field) => [field.column, field])),
    [selectedSemanticDraftEntity]
  );
  const selectedSemanticConfiguredCount = useMemo(
    () => (selectedInfo?.columns || []).filter((column) => isConfiguredSemanticField(selectedSemanticFieldMap[column.name])).length,
    [selectedInfo, selectedSemanticFieldMap]
  );
  const totalConfiguredCount = sanitizedSemanticModel.configuredFieldCount;
  const generationModelSelections = useMemo(
    () => flattenSemanticGenerationSelections(modelProfiles),
    [modelProfiles]
  );
  const selectedGenerationModel = useMemo(
    () => generationModelSelections.find((item) => getAIModelSelectionKey(item) === selectedGenerationModelKey) || null,
    [generationModelSelections, selectedGenerationModelKey]
  );

  const mutateSemanticModel = useCallback((updater: (current: DatabaseSemanticModel) => DatabaseSemanticModel) => {
    setSemanticModel((prev) => rebuildSemanticModel(updater(sanitizeDatabaseSemanticModel(prev) || buildEmptySemanticModel())));
  }, []);

  const updateSemanticTableDescription = useCallback((tableName: string, value: string) => {
    mutateSemanticModel((current) => {
      const entities = [...current.entities];
      const index = entities.findIndex((entity) => entity.table === tableName);
      const nextEntity = buildDefaultSemanticEntity(tableName, index >= 0 ? entities[index] : null);
      nextEntity.description = value.trim();
      if (index >= 0) {
        entities[index] = rebuildSemanticEntity(nextEntity);
      } else {
        entities.push(rebuildSemanticEntity(nextEntity));
      }
      return { ...current, entities };
    });
  }, [buildDefaultSemanticEntity, mutateSemanticModel]);

  const updateSemanticField = useCallback((
    tableName: string,
    columnName: string,
    key: keyof DatabaseSemanticModelField,
    value: string | boolean | string[]
  ) => {
    mutateSemanticModel((current) => {
      const entities = [...current.entities];
      const index = entities.findIndex((entity) => entity.table === tableName);
      const nextEntity = buildDefaultSemanticEntity(tableName, index >= 0 ? entities[index] : null);

      nextEntity.fields = nextEntity.fields.map((field) => {
        if (field.column !== columnName) return field;

        const nextField: DatabaseSemanticModelField = {
          ...field,
          aliases: [...(field.aliases || [])],
          derivedFrom: 'manual',
        };

        if (key === 'enableForNer' && typeof value === 'boolean') {
          nextField.enableForNer = value;
          return nextField;
        }

        if (key === 'aliases' && Array.isArray(value)) {
          nextField.aliases = value;
          return nextField;
        }

        if (key === 'semanticRole' && typeof value === 'string') {
          nextField.semanticRole = value as DatabaseSemanticRole;
          return nextField;
        }

        if (typeof value === 'string') {
          if (key === 'metricName') {
            nextField.metricName = value.trim() || field.metricName || columnName;
          } else if (key === 'description') {
            nextField.description = value.trim();
          } else if (key === 'metricType') {
            nextField.metricType = value.trim();
          } else if (key === 'calcMode') {
            nextField.calcMode = value.trim();
          }
        }

        return nextField;
      });

      if (index >= 0) {
        entities[index] = rebuildSemanticEntity(nextEntity);
      } else {
        entities.push(rebuildSemanticEntity(nextEntity));
      }

      return { ...current, entities };
    });
  }, [buildDefaultSemanticEntity, mutateSemanticModel]);

  const handleResetSelectedSemanticTable = useCallback(() => {
    if (!selectedCollection) return;
    mutateSemanticModel((current) => {
      const entities = current.entities.filter((entity) => entity.table !== selectedCollection);
      entities.push(buildDefaultSemanticEntity(selectedCollection, null));
      return { ...current, entities };
    });
  }, [buildDefaultSemanticEntity, mutateSemanticModel, selectedCollection]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setModelProfilesLoading(true);
      try {
        const response = await fetch('/api/ai-models');
        if (!response.ok) {
          throw new Error('读取模型配置失败');
        }
        const payload = await readApiJson<AIModelProfileSummary[]>(response, '读取模型配置失败');
        if (!cancelled) {
          setModelProfiles(payload);
        }
      } catch {
        if (!cancelled) {
          setModelProfiles([]);
        }
      } finally {
        if (!cancelled) {
          setModelProfilesLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedGenerationModelKey) return;
    if (!generationModelSelections.length) return;
    const defaultSelection = generationModelSelections.find((item) => item.isDefault) || generationModelSelections[0];
    if (defaultSelection) {
      setSelectedGenerationModelKey(getAIModelSelectionKey(defaultSelection));
    }
  }, [generationModelSelections, selectedGenerationModelKey]);

  useEffect(() => {
    if (!instanceId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const [instanceResponse, schemaResponse, semanticResponse] = await Promise.all([
          fetch(`/api/database-instances/${instanceId}`),
          fetch(`/api/database-instances/${instanceId}/schema`),
          fetch(`/api/database-instances/${instanceId}/semantic-model`),
        ]);

        const instancePayload = await readApiJson<DatabaseInstance & { error?: string }>(instanceResponse, '读取数据库实例失败');
        if (!instanceResponse.ok) {
          throw new Error(getApiErrorMessage(instancePayload, '读取数据库实例失败'));
        }

        const schemaPayload = await readApiJson<DatabaseSchemaPayload & { error?: string }>(schemaResponse, '读取数据库结构失败');
        if (!schemaResponse.ok) {
          throw new Error(getApiErrorMessage(schemaPayload, '读取数据库结构失败'));
        }

        const semanticPayload = await readApiJson<DatabaseSemanticModel & { error?: string }>(semanticResponse, '读取语义模型失败');
        if (!semanticResponse.ok) {
          throw new Error(getApiErrorMessage(semanticPayload, '读取语义模型失败'));
        }

        if (cancelled) return;

        const nextInstance = instancePayload as DatabaseInstance;
        const nextSchema = schemaPayload as DatabaseSchemaPayload;
        const nextSemanticModel = sanitizeDatabaseSemanticModel(semanticPayload as DatabaseSemanticModel) || buildEmptySemanticModel();
        const nextTables = nextSchema.collections.filter((item) => item.category === 'table');
        const nextSelectedCollection =
          (initialCollection && nextTables.some((item) => item.name === initialCollection) ? initialCollection : null)
          || nextTables[0]?.name
          || null;

        setInstance(nextInstance);
        setSchema(nextSchema);
        setSemanticModel(nextSemanticModel);
        setSemanticBaseline(JSON.stringify(nextSemanticModel));
        setSelectedCollection(nextSelectedCollection);
      } catch (error) {
        if (!cancelled) {
          showToast(error instanceof Error ? error.message : '读取配置失败', 'error');
          setInstance(null);
          setSchema(null);
          setSemanticModel(buildEmptySemanticModel());
          setSemanticBaseline('{}');
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

  const updateRouteParams = useCallback((collection: string | null) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    if (collection === null) {
      nextParams.delete('collection');
    } else {
      nextParams.set('collection', collection);
    }
    router.replace(`/database-instances/metrics?${nextParams.toString()}`);
  }, [router, searchParams]);

  const handleSelectCollection = useCallback((collectionName: string) => {
    setSelectedCollection(collectionName);
    updateRouteParams(collectionName);
  }, [updateRouteParams]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (!instanceId || !instance || instance.type === 'redis') return false;

    setSaving(true);
    try {
      const semanticResponse = await fetch(`/api/database-instances/${instanceId}/semantic-model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ semanticModel: sanitizedSemanticModel }),
      });
      const semanticPayload = await readApiJson<DatabaseSemanticModel & { error?: string }>(semanticResponse, '保存语义模型失败');
      if (!semanticResponse.ok) {
        throw new Error(getApiErrorMessage(semanticPayload, '保存语义模型失败'));
      }

      const nextSemanticModel = sanitizeDatabaseSemanticModel(semanticPayload as DatabaseSemanticModel) || buildEmptySemanticModel();
      setInstance((prev) => (prev ? { ...prev, semanticModel: nextSemanticModel } : prev));
      setSemanticModel(nextSemanticModel);
      setSemanticBaseline(JSON.stringify(nextSemanticModel));
      showToast('语义配置已保存');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存语义模型失败', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [instance, instanceId, sanitizedSemanticModel, showToast]);

  const handleSave = useCallback(() => {
    void saveCurrent();
  }, [saveCurrent]);

  const unsavedGuard = useUnsavedChangesGuard({
    enabled: true,
    isDirty,
    onSave: saveCurrent,
  });

  const handleRefreshSemanticModel = useCallback(async () => {
    if (!instanceId || !selectedInfo) return;

    setRefreshingSemantic(true);
    try {
      const response = await fetch(`/api/database-instances/${instanceId}/semantic-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persist: false,
          collection: selectedInfo.name,
          selectedModel: selectedGenerationModel ? {
            profileId: selectedGenerationModel.profileId,
            modelId: selectedGenerationModel.modelId,
          } : null,
        }),
      });
      const payload = await readApiJson<DatabaseSemanticModel & { error?: string; message?: string }>(response, '更新语义模型失败');
      if (!response.ok) {
        throw new Error(getApiErrorMessage(payload, '更新语义模型失败'));
      }

      const nextSemanticModel = sanitizeDatabaseSemanticModel(payload as DatabaseSemanticModel) || buildEmptySemanticModel();
      setSemanticModel(nextSemanticModel);
      setInstance((prev) => (prev ? { ...prev, semanticModel: nextSemanticModel } : prev));
      showToast(payload.message || (selectedGenerationModel ? '已按所选模型生成语义草稿' : '已按当前 schema 重新生成语义草稿'));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '更新语义模型失败', 'error');
    } finally {
      setRefreshingSemantic(false);
    }
  }, [instanceId, selectedGenerationModel, selectedInfo, showToast]);

  if (!instanceId) {
    return (
      <div className={styles.emptyPage}>
        <Icons.AlertTriangle size={24} />
        <strong>缺少数据库实例参数</strong>
        <span>请从数据库实例详情页进入语义配置页。</span>
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
            <Icons.Sparkles size={14} />
            Semantic Studio
          </div>
          <div className={styles.heroTitle}>语义配置</div>
          <div className={styles.heroDesc}>
            这里是数据库字段语义的唯一配置入口。我们统一维护字段角色、术语别名、NER 开关和业务口径，DB Harness 与 NL2DATA
            会直接消费这份语义配置，不再单独维护一套重复的指标配置。
          </div>
          <div className={styles.heroMeta}>
            <span className={styles.metaBadge}><Icons.Database size={12} /> {instance?.name || '读取实例中'}</span>
            <span className={styles.metaBadge}><Icons.Layers size={12} /> {tableCollections.length} 张表</span>
            <span className={styles.metaBadge}><Icons.Check size={12} /> 已配置 {totalConfiguredCount} 个字段</span>
            <span className={styles.metaBadge}><Icons.Sparkles size={12} /> 术语 {sanitizedSemanticModel.glossary.length} 项</span>
          </div>
        </div>

        <div className={styles.heroActions}>
          <div className={styles.heroActionTop}>
            <strong>当前配置焦点</strong>
            <span>
              {selectedInfo
                ? `${selectedInfo.name} · ${selectedSemanticConfiguredCount}/${selectedInfo.columns?.length || 0} 字段已补充`
                : '请选择左侧库表'}
            </span>
          </div>
          <div className={styles.heroActionButtons}>
            <button className="btn btn-secondary" type="button" onClick={() => unsavedGuard.confirmAction(() => router.push(detailHref))}>
              <Icons.ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} /> 返回上一页
            </button>
            <Link href={backHref} className="btn btn-secondary">
              <Icons.Database size={16} /> 数据库实例
            </Link>
            <button className="btn btn-primary" type="button" onClick={handleSave} disabled={saving || !isDirty}>
              <Icons.Check size={16} /> {saving ? '保存中...' : '保存语义配置'}
            </button>
          </div>
        </div>
      </section>

      <section className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div>
              <strong>表列表</strong>
              <span>切换当前正在维护语义的数据库表。</span>
            </div>
          </div>
          <div className={styles.schemaList}>
            {tableCollections.map((collection) => {
              const entity = sanitizedSemanticModel.entities.find((item) => item.table === collection.name);
              const configuredCount = (entity?.fields || []).filter((field) => isConfiguredSemanticField(field)).length;
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
                    <span>已配置 {configuredCount}</span>
                    <span>术语 {(entity?.fields || []).filter((field) => field.enableForNer).length}</span>
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
              <strong>正在读取配置</strong>
              <span>正在加载实例详情、表结构和语义模型，请稍候。</span>
            </div>
          ) : !instance || instance.type === 'redis' ? (
            <div className={styles.emptyPage}>
              <Icons.AlertTriangle size={24} />
              <strong>当前实例不支持配置</strong>
              <span>只有 MySQL 与 PostgreSQL 实例支持语义配置。</span>
            </div>
          ) : !selectedInfo || !selectedSemanticDraftEntity ? (
            <div className={styles.emptyPage}>
              <Icons.Layers size={24} />
              <strong>请选择一个数据库表</strong>
              <span>左侧表列表用于切换当前正在配置的对象。</span>
            </div>
          ) : (
            <>
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelTitle}>
                    <strong className={styles.overviewTitle}>
                      语义配置概览
                      <span className={styles.metricFieldHint} tabIndex={0} aria-label="语义配置说明">
                        ?
                        <span className={`${styles.metricFieldTooltip} ${styles.tooltipRightDown}`}>
                          图形化语义配置会按字段维护语义名称、角色、别名和 NER 开关。保存后会同步成系统可消费的语义映射，直接用于 DB Harness 与 NL2DATA。
                        </span>
                      </span>
                    </strong>
                    <span>{selectedInfo.name} · {selectedSemanticConfiguredCount}/{selectedInfo.columns?.length || 0} 字段已补充</span>
                  </div>
                  <div className={styles.panelHeaderMeta}>
                    <div className={styles.badgeRow}>
                      <span className={styles.metricBadge}>实体：{sanitizedSemanticModel.entityCount}</span>
                      <span className={styles.metricBadge}>已配置字段：{sanitizedSemanticModel.configuredFieldCount}</span>
                      <span className={styles.metricBadge}>默认推断：{sanitizedSemanticModel.inferredFieldCount}</span>
                      <span className={styles.metricBadge}>术语：{sanitizedSemanticModel.glossary.length}</span>
                      {isDirty && <span className={styles.metricBadgePending}>存在未保存修改</span>}
                    </div>
                    <div className={styles.panelActionRow}>
                      <div className={styles.generationPicker}>
                        <select
                          className={`form-select ${styles.generationSelect}`}
                          value={selectedGenerationModelKey}
                          onChange={(event) => setSelectedGenerationModelKey(event.target.value)}
                          disabled={modelProfilesLoading || generationModelSelections.length === 0 || refreshingSemantic}
                        >
                          <option value="">
                            {modelProfilesLoading
                              ? '正在加载模型...'
                              : generationModelSelections.length > 0
                                ? '选择自动生成模型'
                                : '暂无可用对话模型'}
                          </option>
                          {generationModelSelections.map((option) => {
                            const optionKey = getAIModelSelectionKey(option);
                            return (
                              <option key={optionKey} value={optionKey}>
                                {option.profileName} / {option.modelId}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={handleRefreshSemanticModel}
                        disabled={refreshingSemantic}
                      >
                        <Icons.Refresh size={14} /> {refreshingSemantic ? '生成中...' : '自动生成语义'}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={handleResetSelectedSemanticTable}
                      >
                        <Icons.X size={14} /> 恢复该表默认语义
                      </button>
                    </div>
                  </div>
                </div>
                <div className={styles.panelBody}>
                  <label className={styles.tableDescriptionField}>
                    <span>整表语义说明</span>
                    <textarea
                      className={`form-input ${styles.tableDescriptionInput}`}
                      value={selectedSemanticDraftEntity.description || ''}
                      onChange={(event) => updateSemanticTableDescription(selectedInfo.name, event.target.value)}
                      placeholder="补充这张表在业务语义层的角色、适用场景、口径边界或注意事项。"
                    />
                  </label>
                </div>
              </div>

              <div className={styles.metricRowList}>
                {selectedInfo.columns?.map((column) => {
                  const field = selectedSemanticFieldMap[column.name];
                  if (!field) return null;

                  const isConfigured = isConfiguredSemanticField(field);

                  return (
                    <section key={column.name} className={`${styles.metricRow} ${isConfigured ? styles.metricRowActive : ''}`}>
                      <div className={styles.metricRowIdentity}>
                        <div className={styles.metricFieldTitle}>
                          <div className={styles.metricFieldNameRow}>
                            <code>{column.name}</code>
                            <span className={styles.metricFieldType}>{column.type}</span>
                            <span className={styles.metricFieldMapped}>{field.semanticRole}</span>
                            <span className={styles.metricFieldType}>
                              {field.derivedFrom === 'manual' ? '手工' : field.derivedFrom === 'mapping' ? '迁移' : '推断'}
                            </span>
                            {field.enableForNer && <span className={styles.metricFieldNer}>NER</span>}
                          </div>
                          <div className={styles.metricFieldMeta}>
                            <span>{column.nullable ? '允许空值' : '必填字段'}</span>
                            <span>默认值：{column.defaultValue ?? '-'}</span>
                            <span>字段备注：{column.comment?.trim() || '-'}</span>
                            <span>当前语义名：{field.metricName}</span>
                          </div>
                        </div>
                      </div>

                      <div className={styles.semanticRowFields}>
                        <label className={styles.metricFormField}>
                          <span>语义名称</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={field.metricName}
                            onChange={(event) => updateSemanticField(selectedInfo.name, column.name, 'metricName', event.target.value)}
                            placeholder="例如：下单时间 / 用户地区 / 支付金额"
                          />
                        </label>

                        <label className={styles.metricFormField}>
                          <span>语义描述</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={field.description || ''}
                            onChange={(event) => updateSemanticField(selectedInfo.name, column.name, 'description', event.target.value)}
                            placeholder="补充业务口径、边界说明和常见提问方式"
                          />
                        </label>

                        <label className={styles.metricFormField}>
                          <span>业务别名</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={(field.aliases || []).join(', ')}
                            onChange={(event) => updateSemanticField(
                              selectedInfo.name,
                              column.name,
                              'aliases',
                              event.target.value.split(',').map((item) => item.trim()).filter(Boolean)
                            )}
                            placeholder="例如：客单价, ARPU, 订单额"
                          />
                        </label>

                        <label className={styles.metricFormField}>
                          <span>语义角色</span>
                          <select
                            className={`form-select ${styles.metricSelect}`}
                            value={field.semanticRole}
                            onChange={(event) => updateSemanticField(selectedInfo.name, column.name, 'semanticRole', event.target.value)}
                          >
                            {SEMANTIC_ROLE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>

                        <label className={styles.metricFormField}>
                          <span>指标类型</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={field.metricType || ''}
                            onChange={(event) => updateSemanticField(selectedInfo.name, column.name, 'metricType', event.target.value)}
                            placeholder="例如：业务指标 / 标签字段 / 时间键"
                          />
                        </label>

                        <label className={styles.metricFormField}>
                          <span>计算口径</span>
                          <input
                            className={`form-input ${styles.metricInput}`}
                            value={field.calcMode || ''}
                            onChange={(event) => updateSemanticField(selectedInfo.name, column.name, 'calcMode', event.target.value)}
                            placeholder="例如：原值 / 求和 / 去重计数"
                          />
                        </label>

                        <div className={styles.metricFormField}>
                          <span className={styles.metricToggleTitle}>
                            名词识别
                            <span className={styles.metricFieldHint} tabIndex={0} aria-label="名词识别说明">
                              ?
                              <span className={`${styles.metricFieldTooltip} ${styles.tooltipRightDown}`}>
                                控制这条语义是否进入 NER 候选集，帮助模型识别业务术语。
                              </span>
                            </span>
                          </span>
                          <div className={styles.metricToggleInputRow}>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={field.enableForNer}
                              className={`${styles.metricToggleButton} ${field.enableForNer ? styles.metricToggleButtonActive : ''}`}
                              onClick={() => updateSemanticField(selectedInfo.name, column.name, 'enableForNer', !field.enableForNer)}
                            >
                              <span className={styles.metricToggleKnob} />
                            </button>
                          </div>
                        </div>
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

export default function DatabaseMetricConfigPage() {
  return (
    <Suspense fallback={null}>
      <DatabaseSemanticConfigPageContent />
    </Suspense>
  );
}

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icons } from '@/components/Icons';
import {
  flattenAIModelSelections,
  getAIModelSelectionKey,
  getDefaultAIModelSelection,
} from '@/lib/ai-models';
import { AIModelProfile, DatabaseInstanceSummary } from '@/lib/types';
import { createPendingTrace } from '@/lib/db-harness/core/trace';
import type {
  DBHarnessCatalogOverview,
  DBHarnessChatMessage,
  DBHarnessKnowledgeFeedbackResponse,
  DBHarnessQueryPlan,
  DBHarnessSemanticOverview,
  DBHarnessSessionRecord,
  DBHarnessTurnResponse,
  DBHarnessWorkspaceRecord,
  DBMultiAgentTraceStep,
} from '@/lib/db-harness/core/types';
import styles from './page.module.css';

interface TraceDisplayItem {
  key: string;
  title: string;
  status: DBMultiAgentTraceStep['status'];
  detail: string;
  handoff?: DBMultiAgentTraceStep['handoff'];
  panel?: ReactNode;
  coreFlow?: ReactNode;
}

function createId() {
  return Math.random().toString(36).slice(2, 10);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function getTraceLabel(status: DBHarnessChatMessage['status']) {
  if (status === 'streaming') return '正在思考';
  if (status === 'error') return '思考中断';
  return '已经完成思考';
}

function getCurrentTraceTitle(trace: DBMultiAgentTraceStep[] | undefined) {
  if (!trace?.length) return '';
  const runningStep = trace.find((step) => step.status === 'running');
  if (runningStep) return runningStep.title;
  const latestCompleted = [...trace].reverse().find((step) => step.status === 'completed');
  return latestCompleted?.title || trace[0]?.title || '';
}

function renderPlanMetric(metric: DBHarnessQueryPlan['metrics'][number]) {
  return `${metric.aggregate.toUpperCase()} ${metric.label} (${metric.table}.${metric.column})`;
}

function renderPlanFilter(filter: DBHarnessQueryPlan['filters'][number]) {
  const value = Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value);
  return `${filter.label} ${filter.operator} ${value}`;
}

function renderPlanOrder(order: DBHarnessQueryPlan['orderBy'][number]) {
  return `${order.label} ${order.direction.toUpperCase()}`;
}

function parseTracePayload(payload: string | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function renderTraceArrayChips(values: unknown) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const items = values
    .map((item) => (typeof item === 'string' ? item : ''))
    .filter(Boolean)
    .slice(0, 8);
  if (items.length === 0) return null;

  return (
    <div className={styles.traceCoreChips}>
      {items.map((item) => (
        <span key={item} className={styles.traceCoreChip}>{item}</span>
      ))}
    </div>
  );
}

function renderTraceCoreFlow(role: DBMultiAgentTraceStep['role'], handoff: DBMultiAgentTraceStep['handoff'] | undefined) {
  const payload = parseTracePayload(handoff?.payload);
  if (!payload) return null;

  if (role === 'intent') {
    const planningHints = payload.planningHints && typeof payload.planningHints === 'object'
      ? payload.planningHints as Record<string, unknown>
      : null;
    return (
      <div className={styles.traceCoreFlow}>
        {typeof payload.intent === 'string' ? (
          <div className={styles.traceCoreRow}>
            <strong>识别意图</strong>
            <span>{payload.intent}</span>
          </div>
        ) : null}
        {Array.isArray(planningHints?.candidateTables) ? (
          <div className={styles.traceCoreBlock}>
            <strong>候选表</strong>
            {renderTraceArrayChips(planningHints?.candidateTables)}
          </div>
        ) : null}
        {Array.isArray(planningHints?.metrics) ? (
          <div className={styles.traceCoreBlock}>
            <strong>核心指标</strong>
            {renderTraceArrayChips(planningHints?.metrics)}
          </div>
        ) : null}
        {Array.isArray(planningHints?.dimensions) ? (
          <div className={styles.traceCoreBlock}>
            <strong>核心维度</strong>
            {renderTraceArrayChips(planningHints?.dimensions)}
          </div>
        ) : null}
      </div>
    );
  }

  if (role === 'schema') {
    const matchedMetrics = Array.isArray(payload.matchedMetrics)
      ? payload.matchedMetrics
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const record = item as Record<string, unknown>;
          const term = typeof record.term === 'string' ? record.term : '';
          const table = typeof record.table === 'string' ? record.table : '';
          const column = typeof record.column === 'string' ? record.column : '';
          return term && table && column ? `${term} -> ${table}.${column}` : '';
        })
        .filter(Boolean)
      : [];

    return (
      <div className={styles.traceCoreFlow}>
        <div className={styles.traceCoreBlock}>
          <strong>归一化术语</strong>
          {renderTraceArrayChips(payload.normalizedTerms)}
        </div>
        {matchedMetrics.length > 0 ? (
          <div className={styles.traceCoreBlock}>
            <strong>语义命中</strong>
            {renderTraceArrayChips(matchedMetrics)}
          </div>
        ) : null}
        {Array.isArray(payload.timeHints) && payload.timeHints.length > 0 ? (
          <div className={styles.traceCoreBlock}>
            <strong>时间线索</strong>
            {renderTraceArrayChips(payload.timeHints)}
          </div>
        ) : null}
      </div>
    );
  }

  if (role === 'query') {
    return (
      <div className={styles.traceCoreFlow}>
        {typeof payload.message === 'string' ? (
          <div className={styles.traceCoreBlock}>
            <strong>生成策略</strong>
            <p className={styles.traceCoreText}>{payload.message}</p>
          </div>
        ) : null}
        {typeof payload.usedFallback === 'boolean' ? (
          <div className={styles.traceCoreRow}>
            <strong>生成方式</strong>
            <span>{payload.usedFallback ? '规则回退' : '模型规划'}</span>
          </div>
        ) : null}
      </div>
    );
  }

  if (role === 'guardrail') {
    return (
      <div className={styles.traceCoreFlow}>
        {typeof payload.rowCount === 'number' ? (
          <div className={styles.traceCoreRow}>
            <strong>执行行数</strong>
            <span>{String(payload.rowCount)}</span>
          </div>
        ) : null}
        {Array.isArray(payload.columns) && payload.columns.length > 0 ? (
          <div className={styles.traceCoreBlock}>
            <strong>返回列</strong>
            {renderTraceArrayChips(payload.columns)}
          </div>
        ) : null}
        {typeof payload.summary === 'string' && payload.summary ? (
          <div className={styles.traceCoreBlock}>
            <strong>执行摘要</strong>
            <p className={styles.traceCoreText}>{payload.summary}</p>
          </div>
        ) : null}
      </div>
    );
  }

  if (role === 'analysis') {
    return (
      <div className={styles.traceCoreFlow}>
        {typeof payload.summary === 'string' && payload.summary ? (
          <div className={styles.traceCoreBlock}>
            <strong>结果总结</strong>
            <p className={styles.traceCoreText}>{payload.summary}</p>
          </div>
        ) : null}
        {Array.isArray(payload.followUps) && payload.followUps.length > 0 ? (
          <div className={styles.traceCoreBlock}>
            <strong>后续追问</strong>
            {renderTraceArrayChips(payload.followUps)}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
}

function renderCatalogCard(catalog: DBHarnessCatalogOverview) {
  return (
    <details className={styles.tracePanel}>
      <summary className={styles.tracePanelSummary}>
        <strong>Catalog</strong>
        <span className={styles.tracePanelMeta}>{`${catalog.entityCount} 个实体 · ${catalog.relationCount} 条关系`}</span>
      </summary>
      <div className={styles.tracePanelBody}>
        {catalog.focusEntities.map((entity) => (
          <div key={entity.table} className={styles.tracePanelSection}>
            <div className={styles.tracePanelRow}>
              <strong>{entity.table}</strong>
              {entity.primaryKeys.length > 0 ? <span className={styles.tracePanelMeta}>主键：{entity.primaryKeys.join(', ')}</span> : null}
            </div>
            {entity.description ? <p className={styles.tracePanelText}>{entity.description}</p> : null}
            {entity.relatedEntities.length > 0 ? (
              <p className={styles.tracePanelText}>关联实体：{entity.relatedEntities.join(', ')}</p>
            ) : null}
            <div className={styles.tracePanelChips}>
              {entity.fields.map((field) => (
                <span key={`${entity.table}-${field.name}`} className={styles.tracePanelChip}>
                  {`${field.name} · ${field.semanticRole}${field.referencesTable ? ` -> ${field.referencesTable}` : ''}`}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function renderSemanticCard(semantic: DBHarnessSemanticOverview) {
  return (
    <details className={styles.tracePanel}>
      <summary className={styles.tracePanelSummary}>
        <strong>Semantic</strong>
        <span className={styles.tracePanelMeta}>{`映射 ${semantic.configuredFieldCount} 个字段 · 推断 ${semantic.inferredFieldCount} 个字段`}</span>
      </summary>
      <div className={styles.tracePanelBody}>
        {semantic.focusEntities.map((entity) => (
          <div key={entity.table} className={styles.tracePanelSection}>
            <div className={styles.tracePanelRow}>
              <strong>{entity.table}</strong>
              {entity.timeFields.length > 0 ? <span className={styles.tracePanelMeta}>时间：{entity.timeFields.join(', ')}</span> : null}
            </div>
            {entity.description ? <p className={styles.tracePanelText}>{entity.description}</p> : null}
            {entity.metrics.length > 0 ? <p className={styles.tracePanelText}>指标：{entity.metrics.join(', ')}</p> : null}
            {entity.dimensions.length > 0 ? <p className={styles.tracePanelText}>维度：{entity.dimensions.join(', ')}</p> : null}
            {entity.nerEnabledFields.length > 0 ? <p className={styles.tracePanelText}>NER：{entity.nerEnabledFields.join(', ')}</p> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function renderQueryPlanCard(plan: DBHarnessQueryPlan) {
  return (
    <details className={styles.tracePanel}>
      <summary className={styles.tracePanelSummary}>
        <strong>Query Plan</strong>
        <span className={styles.tracePanelMeta}>{`${plan.strategy.toUpperCase()} · ${plan.targetTable || '未锁定目标表'} · LIMIT ${plan.limit}`}</span>
      </summary>
      <div className={styles.tracePanelBody}>
        <p className={styles.tracePanelText}>{plan.summary}</p>
        {plan.dimensions.length > 0 ? (
          <div className={styles.tracePanelSection}>
            <div className={styles.tracePanelRow}><strong>Dimensions</strong></div>
            <div className={styles.tracePanelChips}>
              {plan.dimensions.map((dimension) => (
                <span key={`${dimension.table}-${dimension.column}`} className={styles.tracePanelChip}>
                  {`${dimension.label} (${dimension.table}.${dimension.column})`}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {plan.metrics.length > 0 ? (
          <div className={styles.tracePanelSection}>
            <div className={styles.tracePanelRow}><strong>Metrics</strong></div>
            <div className={styles.tracePanelChips}>
              {plan.metrics.map((metric) => (
                <span key={`${metric.table}-${metric.column}`} className={styles.tracePanelChip}>
                  {renderPlanMetric(metric)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {plan.filters.length > 0 ? (
          <div className={styles.tracePanelSection}>
            <div className={styles.tracePanelRow}><strong>Filters</strong></div>
            <div className={styles.tracePanelChips}>
              {plan.filters.map((filter) => (
                <span key={`${filter.table}-${filter.column}-${filter.label}`} className={styles.tracePanelChip}>
                  {renderPlanFilter(filter)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {plan.orderBy.length > 0 ? (
          <div className={styles.tracePanelSection}>
            <div className={styles.tracePanelRow}><strong>Order</strong></div>
            <div className={styles.tracePanelChips}>
              {plan.orderBy.map((order) => (
                <span key={`${order.column}-${order.direction}`} className={styles.tracePanelChip}>
                  {renderPlanOrder(order)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {plan.notes.length > 0 ? <p className={styles.tracePanelText}>说明：{plan.notes.join('；')}</p> : null}
        <pre className={styles.tracePanelCode}>{plan.compiled.previewSql || plan.compiled.text}</pre>
      </div>
    </details>
  );
}

function buildSessionTitle(messages: DBHarnessChatMessage[], fallback = '新会话') {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content?.trim() || '';
  if (!latestUserMessage) return fallback;
  return latestUserMessage.slice(0, 36);
}

function buildLastMessageAt(messages: DBHarnessChatMessage[], fallback: string) {
  return [...messages].reverse().find((message) => message.createdAt)?.createdAt || fallback;
}

function findQuestionForAssistantMessage(messages: DBHarnessChatMessage[], assistantId: string) {
  const targetIndex = messages.findIndex((message) => message.id === assistantId);
  if (targetIndex === -1) return '';

  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index]?.content?.trim() || '';
    }
  }

  return '';
}

function findLatestTraceMessageId(messages: DBHarnessChatMessage[]) {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.trace?.length)?.id || null;
}

function createTransientSession(workspaceId: string): DBHarnessSessionRecord {
  const now = new Date().toISOString();
  return {
    id: createId(),
    workspaceId,
    title: '未命名',
    messages: [],
    selectedDatabaseId: '',
    selectedModel: null,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export default function DbHarnessPage() {
  const [messages, setMessages] = useState<DBHarnessChatMessage[]>([]);
  const [composer, setComposer] = useState('');
  const [databaseInstances, setDatabaseInstances] = useState<DatabaseInstanceSummary[]>([]);
  const [modelProfiles, setModelProfiles] = useState<AIModelProfile[]>([]);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState('');
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [blockingPrompt, setBlockingPrompt] = useState<{
    title: string;
    description: string;
    href: string;
    actionLabel: string;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: 'workspace' | 'session';
    id: string;
  } | null>(null);
  const [workspaceItems, setWorkspaceItems] = useState<DBHarnessWorkspaceRecord[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [activeTraceMessageId, setActiveTraceMessageId] = useState<string | null>(null);
  const [copiedArtifactId, setCopiedArtifactId] = useState<string | null>(null);
  const [feedbackComposerId, setFeedbackComposerId] = useState<string | null>(null);
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, string>>({});
  const [feedbackSubmittingId, setFeedbackSubmittingId] = useState<string | null>(null);
  const [createWorkspaceDialog, setCreateWorkspaceDialog] = useState<boolean>(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [selectedDatabaseForNewWorkspace, setSelectedDatabaseForNewWorkspace] = useState('');
  const [workspaceSettingsDialog, setWorkspaceSettingsDialog] = useState<{ workspaceId: string; tab: 'general' | 'rules' } | null>(null);
  const [workspaceActionMenu, setWorkspaceActionMenu] = useState<string | null>(null);
  const [workspaceSettingsDraft, setWorkspaceSettingsDraft] = useState<{ databaseId: string; rules: string }>({ databaseId: '', rules: '' });
  const [savingWorkspaceSettings, setSavingWorkspaceSettings] = useState(false);
  const workspaceRulesInputRef = useRef<HTMLTextAreaElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSessionRef = useRef<DBHarnessSessionRecord | null>(null);
  const skipNextSessionPersistRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const bootstrappedRef = useRef(false);

  const sqlDatabaseInstances = useMemo(
    () => databaseInstances.filter((item) => item.type === 'mysql' || item.type === 'pgsql' || item.type === 'mongo'),
    [databaseInstances]
  );
  const modelSelections = useMemo(() => flattenAIModelSelections(modelProfiles, 'chat'), [modelProfiles]);
  const defaultModelSelection = useMemo(
    () => getDefaultAIModelSelection(modelProfiles, 'chat'),
    [modelProfiles]
  );
  const selectedDatabase = useMemo(
    () => sqlDatabaseInstances.find((item) => item.id === selectedDatabaseId) || null,
    [selectedDatabaseId, sqlDatabaseInstances]
  );
  const selectedModel = useMemo(
    () => modelSelections.find((item) => getAIModelSelectionKey(item) === selectedModelKey)
      || (!selectedModelKey ? defaultModelSelection : null),
    [defaultModelSelection, modelSelections, selectedModelKey]
  );
  const activeModelKey = selectedModel ? getAIModelSelectionKey(selectedModel) : '';
  const activeWorkspace = useMemo(
    () => workspaceItems.find((item) => item.id === selectedWorkspaceId) || null,
    [selectedWorkspaceId, workspaceItems]
  );
  const activeSession = useMemo(
    () => activeWorkspace?.sessions.find((item) => item.id === selectedSessionId) || null,
    [activeWorkspace, selectedSessionId]
  );
  const activeWorkspaceDatabaseId = activeWorkspace?.databaseId || activeSession?.selectedDatabaseId || selectedDatabaseId || '';
  const activeWorkspaceDatabase = useMemo(
    () => sqlDatabaseInstances.find((item) => item.id === activeWorkspaceDatabaseId) || null,
    [activeWorkspaceDatabaseId, sqlDatabaseInstances]
  );
  const activeTraceMessage = useMemo(
    () => messages.find((message) => message.id === activeTraceMessageId && message.trace?.length) || null,
    [activeTraceMessageId, messages]
  );
  const activeTraceDisplayItems = useMemo<TraceDisplayItem[]>(() => {
    if (!activeTraceMessage) return [];

    const items: TraceDisplayItem[] = [];
    const artifacts = activeTraceMessage.artifacts;

    if (artifacts?.catalogOverview) {
      items.push({
        key: `${activeTraceMessage.id}-preface-catalog`,
        title: '前置步骤 · Catalog',
        status: 'completed',
        detail: `已聚焦 ${artifacts.catalogOverview.focusEntities.length} 个相关实体，用于后续意图与取数规划。`,
        panel: renderCatalogCard(artifacts.catalogOverview),
      });
    }

    if (artifacts?.semanticOverview) {
      items.push({
        key: `${activeTraceMessage.id}-preface-semantic`,
        title: '前置步骤 · Semantic',
        status: 'completed',
        detail: `已准备语义口径与业务术语，当前命中 ${artifacts.semanticOverview.focusEntities.length} 个重点实体。`,
        panel: renderSemanticCard(artifacts.semanticOverview),
      });
    }

    activeTraceMessage.trace?.forEach((step) => {
      items.push({
        key: `${activeTraceMessage.id}-${step.role}`,
        title: step.title,
        status: step.status,
        detail: step.detail,
        handoff: step.handoff,
        coreFlow: renderTraceCoreFlow(step.role, step.handoff),
        panel: step.role === 'query' && artifacts?.queryPlan
          ? renderQueryPlanCard(artifacts.queryPlan)
          : null,
      });
    });

    return items;
  }, [activeTraceMessage]);
  const workspaceSettingsTarget = useMemo(
    () => workspaceItems.find((item) => item.id === workspaceSettingsDialog?.workspaceId) || null,
    [workspaceItems, workspaceSettingsDialog]
  );
  const workspaceSettingsDatabase = useMemo(
    () => {
      const databaseId = workspaceSettingsTarget?.databaseId || workspaceSettingsTarget?.sessions[0]?.selectedDatabaseId || '';
      return sqlDatabaseInstances.find((item) => item.id === databaseId) || null;
    },
    [sqlDatabaseInstances, workspaceSettingsTarget]
  );
  const workspaceStageClassName = activeTraceMessage
    ? `${styles.workspaceStage} ${styles.workspaceStageWithRail}`
    : styles.workspaceStage;

  const hasDatasource = sqlDatabaseInstances.length > 0;
  const hasModel = modelSelections.length > 0;
  const canAttemptSend = !!composer.trim() && !sending;

  async function createSessionForWorkspace(workspaceId: string) {
    const transient = createTransientSession(workspaceId);
    const workspaceDatabaseId = workspaceItems.find((item) => item.id === workspaceId)?.databaseId || '';
    const response = await fetch('/api/db-harness/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: transient.id,
        workspaceId,
        title: transient.title,
        messages: transient.messages,
        selectedDatabaseId: workspaceDatabaseId || transient.selectedDatabaseId,
        selectedModel: transient.selectedModel,
        lastMessageAt: transient.lastMessageAt,
      }),
    });

    if (!response.ok) {
      throw new Error('创建会话失败');
    }

    const created = await response.json() as DBHarnessSessionRecord;
    setWorkspaceItems((current) => current.map((workspace) => (
      workspace.id === workspaceId
        ? {
            ...workspace,
            updatedAt: created.lastMessageAt,
            sessions: [created, ...workspace.sessions],
          }
        : workspace
    )));
    setSelectedWorkspaceId(workspaceId);
    setSelectedSessionId(created.id);
    return created;
  }
  async function createWorkspaceWithSession() {
    if (!selectedDatabaseForNewWorkspace) {
      setErrorMessage('请选择数据库');
      return;
    }

    const workspaceResponse = await fetch('/api/db-harness/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: newWorkspaceName || '未命名',
        databaseId: selectedDatabaseForNewWorkspace,
      }),
    });

    if (!workspaceResponse.ok) {
      throw new Error('创建工作区失败');
    }

    const workspace = await workspaceResponse.json() as DBHarnessWorkspaceRecord;
    setWorkspaceItems((current) => [workspace, ...current]);
    const session = await createSessionForWorkspace(workspace.id);
    setCreateWorkspaceDialog(false);
    setNewWorkspaceName('');
    setSelectedDatabaseForNewWorkspace('');
    return { workspace, session };
  }

  async function ensureActiveSession() {
    if (activeSession) return activeSession;
    if (activeWorkspace) {
      return await createSessionForWorkspace(activeWorkspace.id);
    }
    const created = await createWorkspaceWithSession();
    if (!created) {
      throw new Error('创建工作区会话失败');
    }
    return created.session;
  }

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const [databaseRes, modelRes] = await Promise.all([
          fetch('/api/database-instances', { cache: 'no-store' }),
          fetch('/api/ai-models', { cache: 'no-store' }),
        ]);

        if (!active) return;

        if (databaseRes.ok) {
          const databaseData = await databaseRes.json() as DatabaseInstanceSummary[];
          setDatabaseInstances(Array.isArray(databaseData) ? databaseData : []);
        }

        if (modelRes.ok) {
          const modelData = await modelRes.json() as AIModelProfile[];
          setModelProfiles(Array.isArray(modelData) ? modelData : []);
        }
      } catch (error) {
        console.error('Failed to fetch DB Harness dependencies:', error);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const response = await fetch('/api/db-harness/workspaces', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('读取工作区失败');
        }

        const data = await response.json() as DBHarnessWorkspaceRecord[];
        if (!active) return;

        if (Array.isArray(data) && data.length > 0) {
          setWorkspaceItems(data);
          bootstrappedRef.current = true;
          return;
        }

        if (!bootstrappedRef.current) {
          bootstrappedRef.current = true;
          const workspaceResponse = await fetch('/api/db-harness/workspaces', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: '未命名',
            }),
          });
          if (!workspaceResponse.ok) {
            throw new Error('初始化工作区失败');
          }
          const workspace = await workspaceResponse.json() as DBHarnessWorkspaceRecord;
          const sessionResponse = await fetch('/api/db-harness/sessions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              workspaceId: workspace.id,
              title: '新会话',
              messages: [],
              selectedDatabaseId: '',
              selectedModel: null,
            }),
          });
          if (!sessionResponse.ok) {
            throw new Error('初始化会话失败');
          }
          const session = await sessionResponse.json() as DBHarnessSessionRecord;
          if (!active) return;
          setWorkspaceItems([{ ...workspace, sessions: [session] }]);
          setSelectedWorkspaceId(workspace.id);
          setSelectedSessionId(session.id);
        }
      } catch (error) {
        console.error('Failed to fetch DB Harness workspaces:', error);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!workspaceItems.length) {
      setSelectedWorkspaceId('');
      setSelectedSessionId('');
      return;
    }

    // 只有当当前选中的workspace不存在时，才更新选中的workspace和session
    const currentWorkspace = workspaceItems.find((item) => item.id === selectedWorkspaceId);
    if (!currentWorkspace) {
      const nextWorkspace = workspaceItems[0];
      setSelectedWorkspaceId(nextWorkspace.id);
      const firstSession = nextWorkspace.sessions[0] || null;
      setSelectedSessionId(firstSession?.id || '');
    } else {
      // 只有当当前选中的session不存在时，才更新选中的session
      const currentSession = currentWorkspace.sessions.find((item) => item.id === selectedSessionId);
      if (!currentSession && currentWorkspace.sessions.length > 0) {
        setSelectedSessionId(currentWorkspace.sessions[0].id);
      }
    }
  }, [workspaceItems, selectedWorkspaceId, selectedSessionId]);

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    const currentSession = activeSessionRef.current;
    if (!currentSession) {
      skipNextSessionPersistRef.current = true;
      setMessages([]);
      setActiveTraceMessageId(null);
      return;
    }

    skipNextSessionPersistRef.current = true;
    setMessages(currentSession.messages || []);
    setSelectedDatabaseId(currentSession.selectedDatabaseId || activeWorkspace?.databaseId || '');
    setSelectedModelKey(currentSession.selectedModel ? getAIModelSelectionKey(currentSession.selectedModel) : '');
    setActiveTraceMessageId(findLatestTraceMessageId(currentSession.messages || []));
  }, [activeWorkspace?.databaseId, selectedSessionId]);

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
    const defaultKey = defaultSelection
      ? getAIModelSelectionKey(defaultSelection)
      : getAIModelSelectionKey(modelSelections[0]);

    setSelectedModelKey((current) => (
      current && modelSelections.some((item) => getAIModelSelectionKey(item) === current) ? current : defaultKey
    ));
  }, [modelProfiles, modelSelections]);

  useEffect(() => {
    if (!workspaceSettingsTarget) return;
    setWorkspaceSettingsDraft({
      databaseId: workspaceSettingsTarget.databaseId || '',
      rules: workspaceSettingsTarget.rules || '',
    });
  }, [workspaceSettingsTarget]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  useEffect(() => {
    if (!activeTraceMessageId) return;
    if (messages.some((message) => message.id === activeTraceMessageId && message.trace?.length)) return;
    setActiveTraceMessageId(null);
  }, [activeTraceMessageId, messages]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;

    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 22;
    const maxHeight = lineHeight * 6;

    textarea.style.height = '0px';
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, lineHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [composer]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (skipNextSessionPersistRef.current) {
      skipNextSessionPersistRef.current = false;
      return;
    }

    const currentSession = activeSessionRef.current;
    if (!currentSession) return;

    const nextTitle = buildSessionTitle(messages, currentSession.title);
    const nextLastMessageAt = buildLastMessageAt(messages, currentSession.lastMessageAt);
    const nextSelectedModel = selectedModel
      ? {
          profileId: selectedModel.profileId,
          modelId: selectedModel.modelId,
        }
      : null;
    const hasSessionChanged =
      currentSession.title !== nextTitle ||
      currentSession.messages !== messages ||
      currentSession.selectedDatabaseId !== selectedDatabaseId ||
      currentSession.lastMessageAt !== nextLastMessageAt ||
      (currentSession.selectedModel?.profileId || '') !== (nextSelectedModel?.profileId || '') ||
      (currentSession.selectedModel?.modelId || '') !== (nextSelectedModel?.modelId || '');

    if (!hasSessionChanged) return;

    const updatedAt = new Date().toISOString();
    setWorkspaceItems((current) => current.map((workspace) => {
      let workspaceChanged = false;
      const nextSessions = workspace.sessions.map((session) => {
        if (session.id !== selectedSessionId) return session;
        workspaceChanged = true;
        return {
          ...session,
          title: nextTitle,
          messages,
          selectedDatabaseId,
          selectedModel: nextSelectedModel,
          lastMessageAt: nextLastMessageAt,
          updatedAt,
        };
      });

      return workspaceChanged
        ? {
            ...workspace,
            sessions: nextSessions,
          }
        : workspace;
    }));

    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = window.setTimeout(() => {
      void fetch(`/api/db-harness/sessions/${currentSession.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: nextTitle,
          messages,
          selectedDatabaseId,
          selectedModel: nextSelectedModel,
          lastMessageAt: nextLastMessageAt,
        }),
      }).catch((error) => {
        console.error('Failed to persist DB Harness session:', error);
      });
    }, 420);

    return () => {
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
      }
    };
  }, [messages, selectedDatabaseId, selectedModel, selectedSessionId]);

  function updateAssistantMessage(
    assistantId: string,
    updater: (message: DBHarnessChatMessage) => DBHarnessChatMessage
  ) {
    setMessages((current) => current.map((message) => (
      message.id === assistantId ? updater(message) : message
    )));
  }

  async function playTrace(
    assistantId: string,
    finalResponse: DBHarnessTurnResponse
  ) {
    const traceState = createPendingTrace();

    for (let index = 0; index < finalResponse.trace.length; index += 1) {
      const currentStep = finalResponse.trace[index];
      traceState[index] = {
        ...traceState[index],
        status: 'running',
        detail: `正在执行 ${currentStep.title}…`,
      };
      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        trace: [...traceState],
      }));

      await wait(360);

      traceState[index] = currentStep;
      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        trace: [...traceState],
      }));

      await wait(280);

      if (currentStep.status === 'failed') {
        break;
      }
    }
  }

  async function handleCopyArtifact(message: DBHarnessChatMessage) {
    if (!message.artifacts?.previewRows || !message.artifacts.columns) return;

    const jsonPayload = {
      summary: message.artifacts.summary || '',
      columns: message.artifacts.columns,
      rows: message.artifacts.previewRows,
    };

    await navigator.clipboard.writeText(JSON.stringify(jsonPayload, null, 2));
    setCopiedArtifactId(message.id);
    window.setTimeout(() => {
      setCopiedArtifactId((current) => (current === message.id ? null : current));
    }, 1800);
  }

  async function handleSubmitFeedback(
    message: DBHarnessChatMessage,
    feedbackType: 'positive' | 'corrective'
  ) {
    const question = findQuestionForAssistantMessage(messages, message.id);
    const note = (feedbackDrafts[message.id] || '').trim();
    const databaseId = activeWorkspaceDatabaseId || selectedDatabaseId;

    if (!databaseId) {
      setErrorMessage('当前缺少可关联的数据源，暂时无法写入知识记忆。');
      return;
    }

    if (!question) {
      setErrorMessage('没有找到对应的用户问题，暂时无法写入知识记忆。');
      return;
    }

    if (feedbackType === 'corrective' && !note) {
      setErrorMessage('纠偏反馈需要补充一句说明，方便后续学习。');
      return;
    }

    setFeedbackSubmittingId(message.id);
    setErrorMessage('');
    try {
      const response = await fetch('/api/db-harness/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace?.id,
          sessionId: activeSession?.id,
          messageId: message.id,
          databaseInstanceId: databaseId,
          question,
          reply: message.content,
          feedbackType,
          note,
          artifacts: message.artifacts,
        }),
      });

      const payload = await response.json() as DBHarnessKnowledgeFeedbackResponse | { error?: string };
      if (!response.ok || !('feedback' in payload)) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : '写入知识记忆失败');
      }

      updateAssistantMessage(message.id, (current) => ({
        ...current,
        meta: {
          ...(current.meta || {}),
          feedback: payload.feedback,
        },
      }));
      setFeedbackComposerId((current) => (current === message.id ? null : current));
      setFeedbackDrafts((current) => ({
        ...current,
        [message.id]: '',
      }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '写入知识记忆失败');
    } finally {
      setFeedbackSubmittingId((current) => (current === message.id ? null : current));
    }
  }

  function handleCreateWorkspace() {
    setNewWorkspaceName('');
    setSelectedDatabaseForNewWorkspace(sqlDatabaseInstances[0]?.id || '');
    setCreateWorkspaceDialog(true);
  }

  async function handleCreateSession(workspaceId: string) {
    try {
      setErrorMessage('');
      await createSessionForWorkspace(workspaceId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '创建会话失败');
    }
  }

  async function renameWorkspace(workspaceId: string, nextName: string) {
    try {
      const response = await fetch(`/api/db-harness/workspaces/${workspaceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: nextName }),
      });
      if (!response.ok) {
        throw new Error('重命名 workspace 失败');
      }

      setWorkspaceItems((current) => current.map((workspace) => (
        workspace.id === workspaceId
          ? {
              ...workspace,
              name: nextName,
              updatedAt: new Date().toISOString(),
            }
          : workspace
      )));
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '重命名 workspace 失败');
    }
  }

  async function renameSession(sessionId: string, nextTitle: string) {
    try {
      const response = await fetch(`/api/db-harness/sessions/${sessionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: nextTitle }),
      });
      if (!response.ok) {
        throw new Error('重命名 session 失败');
      }

      setWorkspaceItems((current) => current.map((workspace) => ({
        ...workspace,
        sessions: workspace.sessions.map((session) => (
          session.id === sessionId
            ? {
                ...session,
                title: nextTitle,
                updatedAt: new Date().toISOString(),
              }
            : session
        )),
      })));
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '重命名 session 失败');
    }
  }

  function startWorkspaceEditing(workspaceId: string, currentName: string) {
    setEditingSessionId(null);
    setEditingWorkspaceId(workspaceId);
    setEditingName(currentName);
  }

  function startSessionEditing(sessionId: string, currentTitle: string) {
    setEditingWorkspaceId(null);
    setEditingSessionId(sessionId);
    setEditingName(currentTitle);
  }

  async function commitWorkspaceEditing(workspaceId: string, currentName: string, draftName?: string) {
    const nextName = (draftName ?? editingName).trim();
    setEditingWorkspaceId(null);
    setEditingName('');
    if (!nextName || nextName === currentName) return;
    await renameWorkspace(workspaceId, nextName);
  }

  async function commitSessionEditing(sessionId: string, currentTitle: string, draftTitle?: string) {
    const nextTitle = (draftTitle ?? editingName).trim();
    setEditingSessionId(null);
    setEditingName('');
    if (!nextTitle || nextTitle === currentTitle) return;
    await renameSession(sessionId, nextTitle);
  }

  function cancelInlineEditing() {
    setEditingWorkspaceId(null);
    setEditingSessionId(null);
    setEditingName('');
  }

  async function handleDeleteWorkspace(workspaceId: string) {
    setDeleteConfirm({ type: 'workspace', id: workspaceId });
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;

    try {
      if (deleteConfirm.type === 'workspace') {
        const response = await fetch(`/api/db-harness/workspaces/${deleteConfirm.id}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          throw new Error('删除 workspace 失败');
        }

        setWorkspaceItems((current) => current.filter((item) => item.id !== deleteConfirm.id));
      } else if (deleteConfirm.type === 'session') {
        const response = await fetch(`/api/db-harness/sessions/${deleteConfirm.id}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          throw new Error('删除 session 失败');
        }

        setWorkspaceItems((current) => current.map((workspace) => ({
          ...workspace,
          sessions: workspace.sessions.filter((session) => session.id !== deleteConfirm.id),
        })));
      }
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleteConfirm(null);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    setDeleteConfirm({ type: 'session', id: sessionId });
  }

  function openWorkspaceSettings(workspaceId: string, tab: 'general' | 'rules' = 'general') {
    setWorkspaceSettingsDialog({ workspaceId, tab });
    setWorkspaceActionMenu(null);
  }

  async function handleSaveWorkspaceSettings() {
    if (!workspaceSettingsTarget) return;
    const nextRules = workspaceRulesInputRef.current?.value ?? workspaceSettingsDraft.rules;

    setSavingWorkspaceSettings(true);
    try {
      const response = await fetch(`/api/db-harness/workspaces/${workspaceSettingsTarget.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: workspaceSettingsTarget.name,
          databaseId: workspaceSettingsDraft.databaseId,
          rules: nextRules,
        }),
      });

      if (!response.ok) {
        throw new Error('保存 workspace 设置失败');
      }

      const updated = await response.json() as DBHarnessWorkspaceRecord;
      setWorkspaceItems((current) => current.map((item) => (
        item.id === updated.id
          ? { ...item, ...updated, sessions: item.sessions }
          : item
      )));
      setWorkspaceSettingsDraft((current) => ({ ...current, rules: nextRules }));

      if (selectedWorkspaceId === updated.id && workspaceSettingsDraft.databaseId) {
        setSelectedDatabaseId(workspaceSettingsDraft.databaseId);
      }
      setWorkspaceSettingsDialog(null);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '保存 workspace 设置失败');
    } finally {
      setSavingWorkspaceSettings(false);
    }
  }

  async function handleSend(nextPrompt?: string) {
    const prompt = (nextPrompt ?? composer).trim();
    if (!prompt || sending) return;

    if (!hasDatasource || !selectedDatabase) {
      setBlockingPrompt({
        title: '需要先配置数据源',
        description: 'DB Harness 在真正调用 Agent 前需要一个可用的 MySQL、PostgreSQL 或 MongoDB 数据源。',
        href: '/database-instances',
        actionLabel: '前往数据库实例',
      });
      return;
    }

    if (!hasModel || !selectedModel) {
      setBlockingPrompt({
        title: '需要先配置模型',
        description: 'DB Harness 需要至少一个可用的对话模型，发送时才会继续触发 Harness Agent。',
        href: '/model-management',
        actionLabel: '前往模型管理',
      });
      return;
    }

    let targetSession = activeSession;
    if (!targetSession) {
      targetSession = await ensureActiveSession();
    }

    if (!targetSession) {
      setErrorMessage('当前没有可用会话，请先创建 workspace 或 session。');
      return;
    }

    const userMessage: DBHarnessChatMessage = {
      id: createId(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      status: 'done',
    };

    const assistantId = createId();
    const assistantMessage: DBHarnessChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '正在组织一次 DB-Multi-Agent 取数回合，并准备把 Agent 执行过程同步给你。',
      createdAt: new Date().toISOString(),
      status: 'streaming',
      trace: createPendingTrace(),
      meta: {
        datasourceName: selectedDatabase.name,
        modelLabel: selectedModel.modelId,
      },
    };

    const nextMessages = [...messages, userMessage, assistantMessage];
    const conversation = [
      ...messages.map((item) => ({ role: item.role, content: item.content })),
      { role: 'user' as const, content: prompt },
    ];
    const latestArtifact = [...messages].reverse().find((item) => item.role === 'assistant' && item.artifacts)?.artifacts;

    setMessages(nextMessages);
    setComposer('');
    setSending(true);
    setErrorMessage('');
    setBlockingPrompt(null);
    setActiveTraceMessageId(assistantId);

    try {
      const response = await fetch('/api/db-harness/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace?.id,
          messages: conversation,
          databaseInstanceId: selectedDatabase.id,
          selectedModel: {
            profileId: selectedModel.profileId,
            modelId: selectedModel.modelId,
          },
          currentSql: latestArtifact?.sql || '',
          currentResult: latestArtifact
            ? {
              columns: latestArtifact.columns,
              rows: latestArtifact.previewRows,
              summary: latestArtifact.summary,
            }
            : null,
        }),
      });

      const payload = await response.json() as DBHarnessTurnResponse | { error?: string };
      if (!response.ok) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : 'DB Harness 执行失败');
      }

      if (!('trace' in payload)) {
        throw new Error('DB Harness 执行失败');
      }

      await playTrace(assistantId, payload);

      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        content: payload.reply,
        status: payload.outcome === 'error' ? 'error' : 'done',
        trace: payload.trace as DBMultiAgentTraceStep[],
        artifacts: payload.artifacts,
        followUps: payload.followUps,
      }));
    } catch (error) {
      const nextError = error instanceof Error ? error.message : 'DB Harness 回合执行失败';
      setErrorMessage(nextError);
      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        content: nextError,
        status: 'error',
      }));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.pageLayout}>
        <aside className={styles.workspaceSidebar}>
          <div className={styles.sidebarHeader}>
            <div>
              <p className={styles.sidebarEyebrow}>Workspace</p>
              <h2 className={styles.sidebarTitle}>对话项目</h2>
            </div>
          </div>

          <button
            type="button"
            className={styles.sidebarCreateButton}
            onClick={() => void handleCreateWorkspace()}
          >
            <Icons.Plus size={16} />
            新建 Workspace
          </button>

          <Link href="/db-harness/gepa" className={styles.sidebarSecondaryLink}>
            <Icons.Sparkles size={15} />
            GEPA 工作台
          </Link>

          <div className={styles.workspaceList}>
            {workspaceItems.map((workspaceItem) => {
              const workspaceSelected = workspaceItem.id === selectedWorkspaceId;
              return (
                <section key={workspaceItem.id} className={styles.workspaceCard}>
                  <div className={styles.workspaceCardHeader}>
                    {editingWorkspaceId === workspaceItem.id ? (
                      <div className={`${styles.workspaceTab} ${workspaceSelected ? styles.workspaceTabActive : ''}`}>
                        <Icons.Layers size={15} />
                        <input
                          className={styles.treeEditInput}
                          value={editingName}
                          autoFocus
                          aria-label="编辑 workspace 名称"
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => setEditingName(event.target.value)}
                          onBlur={(event) => void commitWorkspaceEditing(workspaceItem.id, workspaceItem.name, event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void commitWorkspaceEditing(workspaceItem.id, workspaceItem.name, event.currentTarget.value);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelInlineEditing();
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={`${styles.workspaceTab} ${workspaceSelected ? styles.workspaceTabActive : ''}`}
                        onClick={() => {
                          setSelectedWorkspaceId(workspaceItem.id);
                          setSelectedSessionId(workspaceItem.sessions[0]?.id || '');
                        }}
                        onDoubleClick={() => startWorkspaceEditing(workspaceItem.id, workspaceItem.name)}
                      >
                        <Icons.Layers size={15} />
                        <span>{workspaceItem.name}</span>
                      </button>
                    )}

                    <div className={styles.workspaceCardActions}>
                      <button
                        type="button"
                        className={styles.sidebarActionButton}
                        onClick={() => void handleCreateSession(workspaceItem.id)}
                        aria-label="新建会话"
                      >
                        <Icons.Plus size={14} />
                      </button>
                      <div className={styles.workspaceMenuWrap}>
                        <button
                          type="button"
                          className={`${styles.sidebarActionButton} ${styles.workspaceMenuTrigger}`}
                          onClick={() => setWorkspaceActionMenu(workspaceActionMenu === workspaceItem.id ? null : workspaceItem.id)}
                          aria-label="操作"
                        >
                          <Icons.MoreHorizontal size={14} />
                        </button>
                        {workspaceActionMenu === workspaceItem.id && (
                          <>
                            <div 
                              style={{
                                position: 'fixed',
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                zIndex: 999
                              }}
                              onClick={() => setWorkspaceActionMenu(null)}
                            />
                            <div className={styles.workspaceActionMenuPanel}>
                              <button
                                type="button"
                                className={styles.workspaceActionMenuItem}
                                onClick={() => {
                                  openWorkspaceSettings(workspaceItem.id, 'general');
                                }}
                              >
                                设置
                              </button>
                              <button
                                type="button"
                                className={`${styles.workspaceActionMenuItem} ${styles.workspaceActionMenuItemDanger}`}
                                onClick={() => {
                                  void handleDeleteWorkspace(workspaceItem.id);
                                  setWorkspaceActionMenu(null);
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className={styles.sessionList}>
                    {workspaceItem.sessions.length === 0 ? (
                      <button
                        type="button"
                        className={styles.emptySessionButton}
                        onClick={() => void handleCreateSession(workspaceItem.id)}
                      >
                        <Icons.MessageSquare size={14} />
                        新建第一个会话
                      </button>
                    ) : (
                      workspaceItem.sessions.map((session) => (
                        <div key={session.id} className={styles.sessionRow}>
                          {editingSessionId === session.id ? (
                            <div className={`${styles.sessionButton} ${selectedSessionId === session.id ? styles.sessionButtonActive : ''}`}>
                              <Icons.MessageSquare size={14} />
                              <input
                                className={styles.treeEditInput}
                                value={editingName}
                                autoFocus
                                aria-label="编辑 session 名称"
                                onFocus={(event) => event.currentTarget.select()}
                                onChange={(event) => setEditingName(event.target.value)}
                                onBlur={(event) => void commitSessionEditing(session.id, session.title || '新会话', event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void commitSessionEditing(session.id, session.title || '新会话', event.currentTarget.value);
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    cancelInlineEditing();
                                  }
                                }}
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.sessionButton} ${selectedSessionId === session.id ? styles.sessionButtonActive : ''}`}
                              onClick={() => {
                                setSelectedWorkspaceId(workspaceItem.id);
                                setSelectedSessionId(session.id);
                              }}
                              onDoubleClick={() => startSessionEditing(session.id, session.title || '新会话')}
                            >
                              <Icons.MessageSquare size={14} />
                              <span>{session.title || '新会话'}</span>
                            </button>
                          )}
                          <div className={styles.sessionActions}>
                            <button
                              type="button"
                              className={styles.sessionDeleteButton}
                              onClick={() => void handleDeleteSession(session.id)}
                              aria-label="删除 session"
                            >
                              <Icons.Trash size={13} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </aside>

        <div className={workspaceStageClassName}>
          <section className={styles.chatShell}>
            <div className={styles.chatViewport} ref={viewportRef}>
              <div className={styles.chatStage}>
                <div className={styles.chatMain}>
                  {messages.length === 0 ? (
                    <div className={styles.emptyState}>
                      <h2 className={styles.emptyTitle}>从一个业务问题开始</h2>
                    </div>
                  ) : (
                    <div className={styles.messageList}>
                      {messages.map((message) => (
                        <article
                          key={message.id}
                          className={`${styles.messageItem} ${message.role === 'user' ? styles.userMessage : styles.assistantMessage} ${message.status === 'error' ? styles.errorMessage : ''}`}
                        >
                          <div className={styles.messageMeta}>
                            <span className={styles.messageRole}>{message.role === 'user' ? 'You' : 'DB-Multi-Agent'}</span>
                            {message.meta?.datasourceName ? <span>{message.meta.datasourceName}</span> : null}
                            {message.meta?.modelLabel ? <span>{message.meta.modelLabel}</span> : null}
                          </div>

                          {message.trace && message.trace.length > 0 ? (
                            <button
                              type="button"
                              className={`${styles.thoughtToggle} ${activeTraceMessageId === message.id ? styles.thoughtToggleActive : ''}`}
                              onClick={() => setActiveTraceMessageId((current) => (current === message.id ? null : message.id))}
                            >
                              <span className={styles.thoughtToggleLead}>
                                <Icons.Sparkles size={15} />
                                {getTraceLabel(message.status)}
                              </span>
                              {message.status === 'streaming' ? (
                                <span className={styles.thoughtToggleStep}>{getCurrentTraceTitle(message.trace)}</span>
                              ) : null}
                              <span className={styles.thoughtToggleArrow}>
                                {activeTraceMessageId === message.id ? '收起' : '>'}
                              </span>
                            </button>
                          ) : null}

                          <div className={styles.messageBubble}>
                            <p className={styles.messageContent}>{message.content}</p>

                            {message.artifacts ? (
                              <section className={styles.resultCard}>
                                <div className={styles.resultHeader}>
                                  <div>
                                    <div className={styles.artifactLabel}>返回数据</div>
                                    {message.artifacts.summary ? <p className={styles.resultSummary}>{message.artifacts.summary}</p> : null}
                                    {message.artifacts.planSummary ? <p className={styles.resultSummary}>{message.artifacts.planSummary}</p> : null}
                                  </div>
                                  {message.artifacts.columns && message.artifacts.previewRows ? (
                                    <button
                                      type="button"
                                      className={styles.copyButton}
                                      onClick={() => void handleCopyArtifact(message)}
                                    >
                                      <Icons.Download size={14} />
                                      {copiedArtifactId === message.id ? '已复制' : '复制 JSON'}
                                    </button>
                                  ) : null}
                                </div>

                                {message.artifacts.columns && message.artifacts.previewRows ? (
                                  message.artifacts.previewRows.length === 0 ? (
                                    <div className={styles.previewEmpty}>当前没有可展示的预览行。</div>
                                  ) : (
                                    <div className={styles.previewTableWrap}>
                                      <table className={styles.previewTable}>
                                        <thead>
                                          <tr>
                                            {message.artifacts.columns.map((column) => (
                                              <th key={`${message.id}-${column}`}>{column}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {message.artifacts.previewRows.map((row, rowIndex) => (
                                            <tr key={`${message.id}-row-${rowIndex}`}>
                                              {message.artifacts?.columns?.map((column) => (
                                                <td key={`${message.id}-${rowIndex}-${column}`}>{formatCell(row[column])}</td>
                                              ))}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )
                                ) : null}

                              </section>
                            ) : null}

                            {message.followUps && message.followUps.length > 0 ? (
                              <div className={styles.followUpSection}>
                                <div className={styles.followUpLabel}>建议继续追问</div>
                                <div className={styles.followUpList}>
                                  {message.followUps.map((followUp) => (
                                    <button
                                      key={`${message.id}-${followUp}`}
                                      type="button"
                                      className={styles.followUpButton}
                                      onClick={() => void handleSend(followUp)}
                                      disabled={sending}
                                    >
                                      {followUp}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {message.role === 'assistant' && message.artifacts ? (
                              <div className={styles.feedbackSection}>
                                <div className={styles.feedbackHeader}>
                                  <div>
                                    <div className={styles.feedbackLabel}>知识记忆反馈</div>
                                    <p className={styles.feedbackText}>把这轮结果标记为“可复用”或“需要纠偏”，下一轮规划会带上这条学习记录。</p>
                                  </div>
                                  {message.meta?.feedback ? (
                                    <span className={`${styles.feedbackBadge} ${message.meta.feedback.status === 'corrective' ? styles.feedbackBadgeCorrective : styles.feedbackBadgePositive}`}>
                                      {message.meta.feedback.status === 'positive' ? '已写入有效经验' : '已写入纠偏经验'}
                                    </span>
                                  ) : null}
                                </div>

                                {message.meta?.feedback ? (
                                  <div className={styles.feedbackSummary}>
                                    <strong>学习摘要</strong>
                                    <p>{message.meta.feedback.summary}</p>
                                    {message.meta.feedback.note ? <p>备注：{message.meta.feedback.note}</p> : null}
                                  </div>
                                ) : (
                                  <>
                                    <div className={styles.feedbackActions}>
                                      <button
                                        type="button"
                                        className={styles.feedbackActionButton}
                                        onClick={() => void handleSubmitFeedback(message, 'positive')}
                                        disabled={feedbackSubmittingId === message.id}
                                      >
                                        <Icons.Check size={14} />
                                        记为有效经验
                                      </button>
                                      <button
                                        type="button"
                                        className={styles.feedbackActionButton}
                                        onClick={() => setFeedbackComposerId((current) => (current === message.id ? null : message.id))}
                                        disabled={feedbackSubmittingId === message.id}
                                      >
                                        <Icons.MessageSquare size={14} />
                                        需要纠偏
                                      </button>
                                    </div>

                                    {feedbackComposerId === message.id ? (
                                      <div className={styles.feedbackComposer}>
                                        <textarea
                                          className={styles.feedbackTextarea}
                                          value={feedbackDrafts[message.id] || ''}
                                          onChange={(event) => setFeedbackDrafts((current) => ({
                                            ...current,
                                            [message.id]: event.target.value,
                                          }))}
                                          placeholder="补充这轮结果为什么偏了，或希望下一轮优先关注什么。"
                                        />
                                        <div className={styles.feedbackComposerActions}>
                                          <button
                                            type="button"
                                            className={styles.feedbackTextButton}
                                            onClick={() => {
                                              setFeedbackComposerId(null);
                                              setFeedbackDrafts((current) => ({ ...current, [message.id]: '' }));
                                            }}
                                          >
                                            取消
                                          </button>
                                          <button
                                            type="button"
                                            className={styles.feedbackSubmitButton}
                                            onClick={() => void handleSubmitFeedback(message, 'corrective')}
                                            disabled={feedbackSubmittingId === message.id}
                                          >
                                            {feedbackSubmittingId === message.id ? '写入中...' : '写入纠偏经验'}
                                          </button>
                                        </div>
                                      </div>
                                    ) : null}
                                  </>
                                )}
                              </div>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className={styles.composerDock}>
              {errorMessage ? (
                <div className={styles.errorBanner}>
                  <Icons.AlertTriangle size={16} />
                  {errorMessage}
                </div>
              ) : null}

              <div className={styles.composerCard}>
                <textarea
                  ref={composerRef}
                  className={styles.composerInput}
                  name="db-harness-composer"
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canAttemptSend) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder="Ask DB Harness anything about your data sources..."
                  disabled={sending}
                />

                <div className={styles.composerFooter}>
                  <div className={styles.selectorRow}>
                    <select
                      className="form-select"
                      name="db-harness-model"
                      value={activeModelKey}
                      onChange={(event) => setSelectedModelKey(event.target.value)}
                      disabled={!hasModel || sending}
                    >
                      {!hasModel ? <option value="">暂无对话模型</option> : null}
                      {modelSelections.map((item) => {
                        const key = getAIModelSelectionKey(item);
                        return (
                          <option key={key} value={key}>
                            {item.modelId}
                          </option>
                        );
                      })}
                    </select>

                    <div className={styles.datasourceBadge} title={activeWorkspaceDatabase?.name || '当前 workspace 未绑定数据库'}>
                      <Icons.Database size={13} />
                      <span>{activeWorkspaceDatabase?.name || '未绑定数据库'}</span>
                    </div>
                  </div>

                  <div className={styles.actionRow}>
                    <span className={styles.composerHint}>Cmd / Ctrl + Enter 发送</span>
                    <button
                      type="button"
                      className={styles.sendButton}
                      onClick={() => void handleSend()}
                      disabled={!canAttemptSend}
                    >
                      <Icons.Send size={16} />
                      {sending ? '处理中...' : '发送'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {activeTraceMessage ? (
            <aside className={styles.traceRail}>
              <div className={styles.traceRailHeading}>
                <h3 className={styles.traceRailTitle}>链路详情</h3>
                <button
                  type="button"
                  className={styles.traceRailClose}
                  onClick={() => setActiveTraceMessageId(null)}
                  aria-label="关闭思考链路"
                >
                  ×
                </button>
              </div>
              <div className={styles.traceRailList}>
                {activeTraceDisplayItems.map((step, index) => (
                  <div key={step.key} className={styles.traceRailItem}>
                    <div className={styles.traceRailTimeline}>
                      <div className={`${styles.traceDot} ${styles[`traceDot${step.status[0].toUpperCase()}${step.status.slice(1)}`]}`} />
                      {index < activeTraceDisplayItems.length - 1 ? <span className={styles.traceRailLine} /> : null}
                    </div>
                    <div className={styles.traceRailBody}>
                      <div className={styles.traceHeader}>
                        <strong className={styles.traceTitle}>
                          {step.handoff ? (
                            <span className={styles.traceHintWrap} tabIndex={0}>
                              <span className={styles.traceTitleText}>{step.title}</span>
                              <span className={styles.traceHintCard} aria-hidden="true">
                                <span className={styles.traceHintTitle}>{step.handoff.title}</span>
                                <pre className={styles.traceHintPayload}>{step.handoff.payload}</pre>
                              </span>
                            </span>
                          ) : (
                            <span className={styles.traceTitleText}>{step.title}</span>
                          )}
                        </strong>
                        <span className={styles.traceStatus}>{step.status}</span>
                      </div>
                      <p>{step.detail}</p>
                      {step.coreFlow ? <div className={styles.traceCoreWrap}>{step.coreFlow}</div> : null}
                      {step.panel ? <div className={styles.traceEmbeddedPanel}>{step.panel}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            </aside>
          ) : null}
        </div>
      </div>

      {blockingPrompt ? (
        <div className={styles.promptOverlay} role="presentation" onClick={() => setBlockingPrompt(null)}>
          <div
            className={styles.promptDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="db-harness-blocking-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.promptBadge}>
              <Icons.AlertTriangle size={16} />
              无法开始本轮调用
            </div>
            <h3 id="db-harness-blocking-title" className={styles.promptTitle}>{blockingPrompt.title}</h3>
            <p className={styles.promptText}>{blockingPrompt.description}</p>
            <div className={styles.promptActions}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setBlockingPrompt(null)}
              >
                稍后处理
              </button>
              <Link href={blockingPrompt.href} className="btn btn-primary btn-sm" onClick={() => setBlockingPrompt(null)}>
                {blockingPrompt.actionLabel}
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      {deleteConfirm ? (
        <div className={styles.promptOverlay} role="presentation" onClick={() => setDeleteConfirm(null)}>
          <div
            className={styles.promptDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="db-harness-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="db-harness-delete-title" className={styles.promptTitle}>
              {deleteConfirm.type === 'workspace' ? '删除 Workspace' : '删除 Session'}
            </h3>
            <p className={styles.promptText}>
              {deleteConfirm.type === 'workspace' 
                ? '删除这个 workspace 后，下面的所有 session 都会被删除。确定继续吗？'
                : '删除这个 session 后，对话内容将无法恢复。确定继续吗？'
              }
            </p>
            <div className={styles.promptActions}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setDeleteConfirm(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void confirmDelete()}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {createWorkspaceDialog ? (
        <div className={styles.promptOverlay} role="presentation" onClick={() => setCreateWorkspaceDialog(false)}>
          <div
            className={styles.promptDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="db-harness-create-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="db-harness-create-title" className={styles.promptTitle}>创建 Workspace</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label className="form-label">名称</label>
                <input
                  type="text"
                  className="form-input"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="未命名"
                />
              </div>
              <div>
                <label className="form-label">选择数据库</label>
                <select
                  className="form-select"
                  value={selectedDatabaseForNewWorkspace}
                  onChange={(e) => setSelectedDatabaseForNewWorkspace(e.target.value)}
                >
                  {sqlDatabaseInstances.map((db) => (
                    <option key={db.id} value={db.id}>{db.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className={styles.promptActions}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setCreateWorkspaceDialog(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void createWorkspaceWithSession()}
              >
                确认创建
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {workspaceSettingsDialog ? (
        <div className={styles.promptOverlay} role="presentation" onClick={() => setWorkspaceSettingsDialog(null)}>
          <div
            className={styles.workspaceSettingsDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="db-harness-settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <aside className={styles.workspaceSettingsSidebar}>
              <button
                type="button"
                className={styles.workspaceSettingsBack}
                onClick={() => setWorkspaceSettingsDialog(null)}
              >
                <Icons.ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
                返回工作台
              </button>

              <div className={styles.workspaceSettingsNav}>
                <button
                  type="button"
                  className={`${styles.workspaceSettingsNavItem} ${workspaceSettingsDialog.tab === 'general' ? styles.workspaceSettingsNavItemActive : ''}`}
                  onClick={() => setWorkspaceSettingsDialog((current) => current ? { ...current, tab: 'general' } : current)}
                >
                  <Icons.Settings size={16} />
                  常规
                </button>
                <button
                  type="button"
                  className={`${styles.workspaceSettingsNavItem} ${workspaceSettingsDialog.tab === 'rules' ? styles.workspaceSettingsNavItemActive : ''}`}
                  onClick={() => setWorkspaceSettingsDialog((current) => current ? { ...current, tab: 'rules' } : current)}
                >
                  <Icons.Sparkles size={16} />
                  Rules
                </button>
              </div>
            </aside>

            <section className={styles.workspaceSettingsMain}>
              <div className={styles.workspaceSettingsTopbar}>
                <div id="db-harness-settings-title" className={styles.workspaceSettingsTopbarSpacer} />
                <button
                  type="button"
                  className={styles.workspaceSettingsClose}
                  onClick={() => setWorkspaceSettingsDialog(null)}
                  aria-label="关闭 workspace 设置"
                >
                  <Icons.X size={16} />
                </button>
              </div>

              <div className={styles.workspaceSettingsPanel}>
                {workspaceSettingsDialog.tab === 'general' ? (
                  <>
                    <div className={styles.settingsSectionRow}>
                      <div>
                        <div className={styles.settingsSectionTitle}>Workspace 名称</div>
                        <p className={styles.settingsSectionHint}>当前正在查看的项目名称，仅用于识别当前 workspace。</p>
                      </div>
                      <div className={styles.settingsValuePill}>{workspaceSettingsTarget?.name || '未命名 Workspace'}</div>
                    </div>

                    <div className={styles.settingsSectionRow}>
                      <div>
                        <div className={styles.settingsSectionTitle}>数据库</div>
                        <p className={styles.settingsSectionHint}>显示 workspace 创建时选择的数据库名称，作为当前项目的默认取数来源。</p>
                      </div>
                      <div className={styles.settingsValuePill}>
                        <Icons.Database size={15} />
                        <span>{workspaceSettingsDatabase?.name || '未绑定数据库'}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className={styles.settingsRulesPanel}>
                    <div>
                      <div className={styles.settingsSectionTitle}>Workspace Rules</div>
                      <p className={styles.settingsSectionHint}>
                        这些规则会在 DB-Multi-Agent 生成 SQL 时作为补充语料一并送给模型，用来约束口径、表优先级和过滤条件。
                      </p>
                    </div>
                    <textarea
                      key={`${workspaceSettingsTarget?.id || 'workspace'}-rules`}
                      ref={workspaceRulesInputRef}
                      className={styles.settingsRulesInput}
                      defaultValue={workspaceSettingsDraft.rules}
                      onChange={(event) => setWorkspaceSettingsDraft((current) => ({ ...current, rules: event.target.value }))}
                      onInput={(event) => {
                        const target = event.currentTarget;
                        setWorkspaceSettingsDraft((current) => ({ ...current, rules: target.value }));
                      }}
                      placeholder={'例如：\n1. 优先使用 index_basic_info 表。\n2. 如果用户没有明确说明，默认返回最近 30 天数据。\n3. 指数数量统一按 distinct(index_code) 口径统计。'}
                    />
                  </div>
                )}
              </div>

              <div className={styles.workspaceSettingsFooter}>
                {workspaceSettingsDialog.tab === 'rules' ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setWorkspaceSettingsDialog(null)}
                      disabled={savingWorkspaceSettings}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleSaveWorkspaceSettings()}
                      disabled={savingWorkspaceSettings}
                    >
                      {savingWorkspaceSettings ? '保存中...' : '保存规则'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setWorkspaceSettingsDialog(null)}
                  >
                    关闭
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icons } from '@/components/Icons';
import type {
  DBHarnessQueryMetricRecord,
  DBHarnessUpgradeCandidate,
  DBHarnessWorkspaceRecord,
} from '@/lib/db-harness/core/types';
import type { DatabaseInstanceSummary } from '@/lib/types';
import styles from './page.module.css';

type MetricsResponse = { metrics: DBHarnessQueryMetricRecord[] } | { error?: string };
type WorkspaceUpgradeResponse = { upgrades: DBHarnessUpgradeCandidate[] } | { error?: string };
type UpgradeDialogState = {
  mode: 'apply' | 'reject';
  upgrade: DBHarnessUpgradeCandidate;
};

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function getWorkspaceLabel(workspace: DBHarnessWorkspaceRecord) {
  const latestSession = [...workspace.sessions]
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt))[0];
  return latestSession?.title?.trim()
    ? `${workspace.name} · ${latestSession.title}`
    : workspace.name;
}

function getOutcomeClass(outcome: DBHarnessQueryMetricRecord['outcome']) {
  if (outcome === 'success') return styles.outcomeSuccess;
  if (outcome === 'empty') return styles.outcomeEmpty;
  return styles.outcomeError;
}

function getUpgradeRecommendation(evaluation: DBHarnessUpgradeCandidate['evaluation']) {
  if (!evaluation) {
    return {
      label: '待评估',
      detail: '请先点击“评估”获取建议结果。',
      recommended: false,
      pending: true,
    };
  }
  const score = Number.isFinite(evaluation.score) ? evaluation.score : NaN;
  const baseline = Number.isFinite(evaluation.baselineScore) ? evaluation.baselineScore : NaN;
  if (!Number.isFinite(score) || !Number.isFinite(baseline)) {
    return {
      label: '待评估',
      detail: '评估结果数据不完整，请重新点击“评估”。',
      recommended: false,
      pending: true,
    };
  }
  const positiveDelta = score - baseline;
  const shouldUpgrade = score >= 0.7 && positiveDelta >= -0.01 && evaluation.emptyRate <= 0.4;
  return {
    label: shouldUpgrade ? '建议升级' : '不建议升级',
    detail: `score ${score.toFixed(3)} · baseline ${baseline.toFixed(3)} · Δ${positiveDelta >= 0 ? '+' : ''}${positiveDelta.toFixed(3)}`,
    recommended: shouldUpgrade,
    pending: false,
  };
}

function buildPromptStrategyAfter(before: string, patch: string): string {
  const safePatch = patch.trim();
  if (!safePatch) return before;
  const safeBefore = before.trim();
  if (!safeBefore) return safePatch;
  if (safeBefore.includes(safePatch)) return safeBefore;
  return `${safeBefore}\n\n${safePatch}`;
}

function buildUpgradeChangePreview(upgrade: DBHarnessUpgradeCandidate, currentPromptStrategy: string) {
  const promptPatch = (upgrade.artifact.promptPatch || '').trim();
  const beforePrompt = currentPromptStrategy.trim() || '（空）';
  const afterPrompt = buildPromptStrategyAfter(currentPromptStrategy, promptPatch).trim() || '（空）';
  const previewRows = [
    {
      label: 'Prompt Strategy',
      before: beforePrompt,
      after: afterPrompt,
    },
  ];
  if (upgrade.artifactType === 'query_template' || upgrade.artifactType === 'analysis_template') {
    previewRows.push({
      label: '模板资产',
      before: '未新增当前升级模板',
      after: `新增模板：${upgrade.title}`,
    });
  }
  if (upgrade.artifactType === 'correction_rule') {
    previewRows.push({
      label: '纠正规则',
      before: '当前 workspace 未注入该纠正规则',
      after: '将写入该升级对应的 correction rule 记忆项',
    });
  }
  return previewRows;
}

function summarizeMetrics(metrics: DBHarnessQueryMetricRecord[]) {
  const total = metrics.length;
  const successCount = metrics.filter((metric) => metric.outcome === 'success').length;
  const emptyCount = metrics.filter((metric) => metric.outcome === 'empty').length;
  const errorCount = metrics.filter((metric) => metric.outcome === 'error').length;
  const cacheHits = metrics.filter((metric) => metric.fromCache).length;
  const avgConfidence = total > 0
    ? metrics.reduce((sum, metric) => sum + metric.confidence, 0) / total
    : 0;
  const avgRowCount = total > 0
    ? metrics.reduce((sum, metric) => sum + metric.rowCount, 0) / total
    : 0;
  const lowConfidenceCount = metrics.filter((metric) => metric.confidence < 0.72).length;
  const reviewValidationCount = metrics.filter((metric) =>
    metric.labels.includes('validation-review') || metric.labels.includes('validation-fail')
  ).length;

  const buildAgentSummary = (agent: 'intent' | 'schema' | 'query') => {
    const latencies = metrics
      .map((metric) => metric.agentTelemetry?.[agent]?.latencyMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const tokens = metrics
      .map((metric) => metric.agentTelemetry?.[agent]?.usage?.totalTokens)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return {
      avgLatencyMs: latencies.length > 0
        ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : 0,
      avgTokens: tokens.length > 0
        ? Math.round(tokens.reduce((sum, value) => sum + value, 0) / tokens.length)
        : 0,
      samples: latencies.length,
    };
  };

  return {
    total,
    successCount,
    emptyCount,
    errorCount,
    cacheHits,
    avgConfidence,
    avgRowCount,
    lowConfidenceCount,
    reviewValidationCount,
    intent: buildAgentSummary('intent'),
    schema: buildAgentSummary('schema'),
    query: buildAgentSummary('query'),
  };
}

export default function DBHarnessMetricsPage() {
  const [workspaces, setWorkspaces] = useState<DBHarnessWorkspaceRecord[]>([]);
  const [databases, setDatabases] = useState<DatabaseInstanceSummary[]>([]);
  const [metrics, setMetrics] = useState<DBHarnessQueryMetricRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [databaseId, setDatabaseId] = useState('');
  const [limit, setLimit] = useState('60');
  const [workspaceUpgrades, setWorkspaceUpgrades] = useState<DBHarnessUpgradeCandidate[]>([]);
  const [upgradesLoading, setUpgradesLoading] = useState(false);
  const [upgradeActionLoading, setUpgradeActionLoading] = useState('');
  const [upgradeError, setUpgradeError] = useState('');
  const [upgradeDialog, setUpgradeDialog] = useState<UpgradeDialogState | null>(null);

  async function loadDependencies() {
    const [workspaceRes, databaseRes] = await Promise.all([
      fetch('/api/db-harness/workspaces', { cache: 'no-store' }),
      fetch('/api/database-instances', { cache: 'no-store' }),
    ]);

    if (workspaceRes.ok) {
      const payload = await workspaceRes.json() as DBHarnessWorkspaceRecord[];
      setWorkspaces(Array.isArray(payload) ? payload : []);
    }
    if (databaseRes.ok) {
      const payload = await databaseRes.json() as DatabaseInstanceSummary[];
      setDatabases(Array.isArray(payload) ? payload : []);
    }
  }

  const loadMetrics = useCallback(async (nextWorkspaceId = workspaceId, nextDatabaseId = databaseId, nextLimit = limit) => {
    const query = new URLSearchParams();
    if (nextWorkspaceId) query.set('workspaceId', nextWorkspaceId);
    if (nextDatabaseId) query.set('databaseId', nextDatabaseId);
    query.set('limit', nextLimit);
    const response = await fetch(`/api/db-harness/metrics?${query.toString()}`, { cache: 'no-store' });
    const payload = await response.json() as MetricsResponse;
    if (!response.ok || !('metrics' in payload)) {
      throw new Error('读取指标看板失败');
    }
    setMetrics(payload.metrics || []);
  }, [workspaceId, databaseId, limit]);

  const loadWorkspaceUpgrades = useCallback(async (nextWorkspaceId = workspaceId) => {
    if (!nextWorkspaceId) {
      setWorkspaceUpgrades([]);
      return;
    }
    setUpgradesLoading(true);
    try {
      const response = await fetch(`/api/db-harness/workspaces/${encodeURIComponent(nextWorkspaceId)}/upgrades`, { cache: 'no-store' });
      const payload = await response.json() as WorkspaceUpgradeResponse;
      if (!response.ok || !('upgrades' in payload)) {
        throw new Error('读取 workspace 升级列表失败');
      }
      const visibleUpgrades = (payload.upgrades || []).filter((item) => item.status !== 'rejected');
      setWorkspaceUpgrades(visibleUpgrades);
      setUpgradeError('');
    } catch (error) {
      setUpgradeError(error instanceof Error ? error.message : '读取 workspace 升级列表失败');
    } finally {
      setUpgradesLoading(false);
    }
  }, [workspaceId]);

  const triggerWorkspaceUpgradeAction = useCallback(async (
    action: 'extract' | 'evaluate' | 'apply' | 'reject',
    options?: { upgradeId?: string; reason?: string }
  ) => {
    if (!workspaceId) return false;
    const loadingKey = `${action}:${options?.upgradeId || 'workspace'}`;
    setUpgradeActionLoading(loadingKey);
    try {
      if (action === 'extract') {
        const response = await fetch(`/api/db-harness/workspaces/${encodeURIComponent(workspaceId)}/upgrades/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error('抽取升级候选失败');
      } else if (action === 'evaluate') {
        const response = await fetch(`/api/db-harness/workspaces/${encodeURIComponent(workspaceId)}/upgrades/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upgradeId: options?.upgradeId }),
        });
        if (!response.ok) throw new Error('评估升级候选失败');
      } else if (action === 'apply') {
        const response = await fetch(`/api/db-harness/workspaces/${encodeURIComponent(workspaceId)}/upgrades/${encodeURIComponent(options?.upgradeId || '')}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error('应用升级候选失败');
      } else {
        const response = await fetch(`/api/db-harness/workspaces/${encodeURIComponent(workspaceId)}/upgrades/${encodeURIComponent(options?.upgradeId || '')}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: options?.reason || 'manual-reject' }),
        });
        if (!response.ok) throw new Error('拒绝升级候选失败');
      }
      await loadWorkspaceUpgrades(workspaceId);
      setUpgradeError('');
      return true;
    } catch (error) {
      setUpgradeError(error instanceof Error ? error.message : '升级操作失败');
      return false;
    } finally {
      setUpgradeActionLoading('');
    }
  }, [workspaceId, loadWorkspaceUpgrades]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        await loadDependencies();
        if (!active) return;
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : '读取依赖失败');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (workspaceId) return;
    const firstWorkspace = workspaces[0];
    const firstDatabase = databases[0];
    if (!firstWorkspace && !firstDatabase) return;
    setWorkspaceId(firstWorkspace?.id || '');
    setDatabaseId(firstWorkspace?.databaseId || firstDatabase?.id || '');
  }, [workspaces, databases, workspaceId]);

  useEffect(() => {
    if (!loading) {
      setRefreshing(true);
      void loadMetrics().catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : '读取指标失败');
      }).finally(() => {
        setRefreshing(false);
      });
      void loadWorkspaceUpgrades().catch((error) => {
        setUpgradeError(error instanceof Error ? error.message : '读取 workspace 升级失败');
      });
    }
  }, [workspaceId, databaseId, limit, loading, loadMetrics, loadWorkspaceUpgrades]);

  const summary = useMemo(() => summarizeMetrics(metrics), [metrics]);
  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId) || null,
    [workspaces, workspaceId]
  );
  const activeDatabase = useMemo(
    () => databases.find((item) => item.id === databaseId) || null,
    [databases, databaseId]
  );
  const upgradeDialogLoadingKey = useMemo(() => {
    if (!upgradeDialog) return '';
    return `${upgradeDialog.mode}:${upgradeDialog.upgrade.id}`;
  }, [upgradeDialog]);
  const upgradePreviewRows = useMemo(() => {
    if (!upgradeDialog || upgradeDialog.mode !== 'apply') return [];
    const currentPromptStrategy = activeWorkspace?.runtimeConfig?.promptStrategy || '';
    return buildUpgradeChangePreview(upgradeDialog.upgrade, currentPromptStrategy);
  }, [upgradeDialog, activeWorkspace]);

  const handleConfirmUpgradeDialog = useCallback(async () => {
    if (!upgradeDialog) return;
    const success = await triggerWorkspaceUpgradeAction(upgradeDialog.mode, {
      upgradeId: upgradeDialog.upgrade.id,
    });
    if (success) {
      setUpgradeDialog(null);
    }
  }, [upgradeDialog, triggerWorkspaceUpgradeAction]);

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>DB Harness</p>
          <h1 className={styles.title}>指标看板</h1>
          <p className={styles.description}>
            聚焦最近回合的成功率、缓存命中、低置信度分布，以及 Intent / Schema / Query 的平均延迟。
          </p>
        </div>
        <div className={styles.heroActions}>
          <Link href="/db-harness" className={styles.secondaryLink}>
            <Icons.MessageSquare size={15} />
            返回对话
          </Link>
          <Link href="/db-harness/gepa" className={styles.secondaryLink}>
            <Icons.Sparkles size={15} />
            GEPA 工作台
          </Link>
        </div>
      </header>

      <section className={styles.filterCard}>
        <div className={styles.field}>
          <label>Workspace</label>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {getWorkspaceLabel(workspace)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>数据源</label>
          <select value={databaseId} onChange={(event) => setDatabaseId(event.target.value)}>
            <option value="">全部数据源</option>
            {databases.map((database) => (
              <option key={database.id} value={database.id}>
                {database.name} · {database.type}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>样本范围</label>
          <select value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="24">最近 24 条</option>
            <option value="60">最近 60 条</option>
            <option value="120">最近 120 条</option>
          </select>
        </div>
        <div className={styles.contextMeta}>
          <span>{activeWorkspace ? activeWorkspace.name : '未选择 Workspace'}</span>
          <span>{activeDatabase ? `${activeDatabase.name} · ${activeDatabase.type}` : '全部数据源'}</span>
          <span>{refreshing ? '刷新中…' : `已加载 ${metrics.length} 条记录`}</span>
        </div>
      </section>

      {errorMessage ? <div className={styles.errorBanner}>{errorMessage}</div> : null}

      {loading ? (
        <div className={styles.emptyState}>正在加载指标看板…</div>
      ) : (
        <>
          <section className={styles.summaryGrid}>
            <article className={styles.metricCard}>
              <span className={styles.metricLabel}>总回合数</span>
              <strong>{summary.total}</strong>
              <p>覆盖 success / empty / error 三类结果。</p>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricLabel}>成功率</span>
              <strong>{summary.total > 0 ? formatPercent(summary.successCount / summary.total) : '0%'}</strong>
              <p>empty {summary.emptyCount} 条，error {summary.errorCount} 条。</p>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricLabel}>缓存命中率</span>
              <strong>{summary.total > 0 ? formatPercent(summary.cacheHits / summary.total) : '0%'}</strong>
              <p>fromCache 回合 {summary.cacheHits} 条。</p>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricLabel}>平均置信度</span>
              <strong>{summary.avgConfidence.toFixed(3)}</strong>
              <p>低置信度回合 {summary.lowConfidenceCount} 条。</p>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricLabel}>平均返回行数</span>
              <strong>{summary.avgRowCount.toFixed(1)}</strong>
              <p>反映当前查询结果密度。</p>
            </article>
            <article className={styles.metricCard}>
              <span className={styles.metricLabel}>需复核结果</span>
              <strong>{summary.reviewValidationCount}</strong>
              <p>来自 validation-review / validation-fail 标签。</p>
            </article>
          </section>

          <section className={styles.agentGrid}>
            {[
              { key: 'intent', title: 'Intent Agent', data: summary.intent },
              { key: 'schema', title: 'Schema Agent', data: summary.schema },
              { key: 'query', title: 'Query Agent', data: summary.query },
            ].map((item) => (
              <article key={item.key} className={styles.agentCard}>
                <div className={styles.agentHeader}>
                  <strong>{item.title}</strong>
                  <span>{item.data.samples} 条有效样本</span>
                </div>
                <div className={styles.agentStats}>
                  <div>
                    <span>平均延迟</span>
                    <strong>{item.data.avgLatencyMs} ms</strong>
                  </div>
                  <div>
                    <span>平均 tokens</span>
                    <strong>{item.data.avgTokens}</strong>
                  </div>
                </div>
              </article>
            ))}
          </section>

          <section className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <div>
                <h2>Workspace 升级治理</h2>
                <p>候选只来自当前 workspace；评估后可应用到当前 workspace 或拒绝。</p>
              </div>
              <div className={styles.upgradeActions}>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={!workspaceId || upgradeActionLoading === 'extract:workspace'}
                  onClick={() => void triggerWorkspaceUpgradeAction('extract')}
                >
                  <Icons.Sparkles size={14} />
                  {upgradeActionLoading === 'extract:workspace' ? '抽取中...' : '抽取候选'}
                </button>
              </div>
            </div>
            {upgradeError ? <div className={styles.errorBanner}>{upgradeError}</div> : null}
            {upgradesLoading ? (
              <div className={styles.emptyState}>正在加载升级候选…</div>
            ) : workspaceUpgrades.length === 0 ? (
              <div className={styles.emptyState}>当前 workspace 还没有升级候选。</div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>标题</th>
                      <th>目标</th>
                      <th>类型</th>
                      <th>状态</th>
                      <th>置信度</th>
                      <th>评估分</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspaceUpgrades.map((upgrade) => {
                      const evaluateKey = `evaluate:${upgrade.id}`;
                      const applyKey = `apply:${upgrade.id}`;
                      const rejectKey = `reject:${upgrade.id}`;
                      return (
                        <tr key={upgrade.id}>
                          <td>
                            <div className={styles.questionCell}>
                              <strong>{upgrade.title}</strong>
                              <span>{upgrade.description || '—'}</span>
                            </div>
                          </td>
                          <td>{upgrade.target}</td>
                          <td>{upgrade.artifactType}</td>
                          <td>{upgrade.status}</td>
                          <td>{upgrade.confidence.toFixed(3)}</td>
                          <td>
                            <div className={styles.questionCell}>
                              <strong>{upgrade.evaluation?.score?.toFixed(3) || '—'}</strong>
                              {(() => {
                                const recommendation = getUpgradeRecommendation(upgrade.evaluation);
                                return (
                                  <span
                                    className={
                                      recommendation.pending
                                        ? styles.upgradeRecommendationPending
                                        : recommendation.recommended
                                          ? styles.upgradeRecommendationYes
                                          : styles.upgradeRecommendationNo
                                    }
                                  >
                                    {recommendation.label} · {recommendation.detail}
                                  </span>
                                );
                              })()}
                            </div>
                          </td>
                          <td>
                            <div className={styles.upgradeRowActions}>
                              <button
                                className="btn btn-secondary btn-sm"
                                type="button"
                                disabled={upgradeActionLoading === evaluateKey || upgrade.status === 'applied' || upgrade.status === 'rejected'}
                                onClick={() => void triggerWorkspaceUpgradeAction('evaluate', { upgradeId: upgrade.id })}
                              >
                                {upgradeActionLoading === evaluateKey ? '评估中...' : '评估'}
                              </button>
                              <button
                                className="btn btn-primary btn-sm"
                                type="button"
                                disabled={upgradeActionLoading === applyKey || upgrade.status === 'applied' || upgrade.status === 'rejected'}
                                onClick={() => setUpgradeDialog({ mode: 'apply', upgrade })}
                              >
                                {upgradeActionLoading === applyKey ? '应用中...' : '应用'}
                              </button>
                              <button
                                className="btn btn-danger btn-sm"
                                type="button"
                                disabled={upgradeActionLoading === rejectKey || upgrade.status === 'applied' || upgrade.status === 'rejected'}
                                onClick={() => setUpgradeDialog({ mode: 'reject', upgrade })}
                              >
                                {upgradeActionLoading === rejectKey ? '处理中...' : '拒绝'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <div>
                <h2>最近回合明细</h2>
                <p>优先查看 error / empty / 低置信度 / 需复核结果，快速定位需要继续优化的问句。</p>
              </div>
            </div>
            {metrics.length === 0 ? (
              <div className={styles.emptyState}>当前筛选条件下还没有指标记录。</div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>问题</th>
                      <th>结果</th>
                      <th>confidence</th>
                      <th>缓存</th>
                      <th>行数</th>
                      <th>Query 延迟</th>
                      <th>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map((metric) => (
                      <tr key={metric.id}>
                        <td>
                          <div className={styles.questionCell}>
                            <strong>{metric.question || '未记录问题'}</strong>
                            {metric.labels.length > 0 ? (
                              <div className={styles.labelRow}>
                                {metric.labels.slice(0, 4).map((label) => (
                                  <span key={`${metric.id}-${label}`} className={styles.tableLabel}>{label}</span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <span className={`${styles.outcomeBadge} ${getOutcomeClass(metric.outcome)}`}>
                            {metric.outcome}
                          </span>
                        </td>
                        <td>{metric.confidence.toFixed(3)}</td>
                        <td>{metric.fromCache ? '命中' : '实时'}</td>
                        <td>{metric.rowCount}</td>
                        <td>{metric.agentTelemetry?.query?.latencyMs || 0} ms</td>
                        <td>{formatDate(metric.updatedAt || metric.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {upgradeDialog ? (
            <div className={styles.dialogMask}>
              <div className={styles.dialogCard}>
                <div className={styles.dialogHeader}>
                  <strong>{upgradeDialog.mode === 'apply' ? '确认应用升级' : '确认拒绝升级'}</strong>
                  <button
                    className={styles.dialogClose}
                    type="button"
                    onClick={() => setUpgradeDialog(null)}
                    disabled={upgradeActionLoading === upgradeDialogLoadingKey}
                    aria-label="关闭弹窗"
                  >
                    ×
                  </button>
                </div>
                <div className={styles.dialogBody}>
                  <p className={styles.dialogTitle}>{upgradeDialog.upgrade.title}</p>
                  <p className={styles.dialogDesc}>{upgradeDialog.upgrade.description || '—'}</p>
                  {upgradeDialog.mode === 'apply' ? (
                    <div className={styles.changePreview}>
                      {upgradePreviewRows.map((row) => (
                        <div key={`${upgradeDialog.upgrade.id}-${row.label}`} className={styles.changeRow}>
                          <span className={styles.changeLabel}>{row.label}</span>
                          <div className={styles.changeColumns}>
                            <div>
                              <span className={styles.changeTag}>修改前</span>
                              <pre>{row.before}</pre>
                            </div>
                            <div>
                              <span className={styles.changeTag}>修改后</span>
                              <pre>{row.after}</pre>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.dialogDesc}>拒绝后该候选将标记为 `rejected`，不会应用到当前 workspace。</p>
                  )}
                </div>
                <div className={styles.dialogActions}>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => setUpgradeDialog(null)}
                    disabled={upgradeActionLoading === upgradeDialogLoadingKey}
                  >
                    取消
                  </button>
                  <button
                    className={upgradeDialog.mode === 'apply' ? 'btn btn-primary btn-sm' : 'btn btn-danger btn-sm'}
                    type="button"
                    onClick={() => void handleConfirmUpgradeDialog()}
                    disabled={upgradeActionLoading === upgradeDialogLoadingKey}
                  >
                    {upgradeActionLoading === upgradeDialogLoadingKey
                      ? (upgradeDialog.mode === 'apply' ? '应用中...' : '处理中...')
                      : (upgradeDialog.mode === 'apply' ? '确认应用' : '确认拒绝')}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

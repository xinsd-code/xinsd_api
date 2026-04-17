'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icons } from '@/components/Icons';
import type { DBHarnessQueryMetricRecord, DBHarnessWorkspaceRecord } from '@/lib/db-harness/core/types';
import type { DatabaseInstanceSummary } from '@/lib/types';
import styles from './page.module.css';

type MetricsResponse = { metrics: DBHarnessQueryMetricRecord[] } | { error?: string };

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
    }
  }, [workspaceId, databaseId, limit, loading, loadMetrics]);

  const summary = useMemo(() => summarizeMetrics(metrics), [metrics]);
  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId) || null,
    [workspaces, workspaceId]
  );
  const activeDatabase = useMemo(
    () => databases.find((item) => item.id === databaseId) || null,
    [databases, databaseId]
  );

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
        </>
      )}
    </div>
  );
}

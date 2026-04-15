'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '@/components/Icons';
import type {
  DBHarnessGepaCandidate,
  DBHarnessGepaRun,
  DBHarnessGepaScoreCard,
  DBHarnessRuntimeConfig,
  DBHarnessRuntimeConfigDiffEntry,
  DBHarnessWorkspaceRecord,
} from '@/lib/db-harness/core/types';
import { DatabaseInstanceSummary } from '@/lib/types';
import styles from './page.module.css';

type GepaListResponse = { runs: DBHarnessGepaRun[] } | { error?: string };
type GepaCreateResponse = { run: DBHarnessGepaRun } | { error?: string };
type GepaApplyResponse = { run: DBHarnessGepaRun; workspace?: DBHarnessWorkspaceRecord | null } | { error?: string };
type GepaDeleteResponse = { success: true; id: string } | { error?: string };

function formatNumber(value: number | undefined, fractionDigits = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

function formatPercent(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0%';
  return `${(value * 100).toFixed(1)}%`;
}

function scoreTrend(score: DBHarnessGepaScoreCard) {
  if (typeof score.baselineBalancedScore !== 'number') return 'baseline';
  const delta = score.balancedScore - score.baselineBalancedScore;
  if (delta > 0) return `+${delta.toFixed(2)}`;
  if (delta < 0) return delta.toFixed(2);
  return '0.00';
}

function candidateKindLabel(candidate: DBHarnessGepaCandidate) {
  return candidate.kind === 'prompt' ? 'Prompt' : 'Policy';
}

function parseRuntimeConfigDiff(run: DBHarnessGepaRun | null): DBHarnessRuntimeConfigDiffEntry[] {
  const raw = run?.report && typeof run.report === 'object'
    ? (run.report as Record<string, unknown>).runtimeConfigDiff
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as DBHarnessRuntimeConfigDiffEntry)
    .filter((item) => item.label && typeof item.before === 'string' && typeof item.after === 'string');
}

function parseRuntimeConfigSnapshot(run: DBHarnessGepaRun | null, key: 'runtimeConfigBefore' | 'runtimeConfigAfter'): DBHarnessRuntimeConfig | null {
  const raw = run?.report && typeof run.report === 'object'
    ? (run.report as Record<string, unknown>)[key]
    : null;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as DBHarnessRuntimeConfig
    : null;
}

function parseAppliedCandidateLabels(run: DBHarnessGepaRun | null): string[] {
  const raw = run?.report && typeof run.report === 'object'
    ? (run.report as Record<string, unknown>).appliedCandidates
    : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const record = item as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title : '';
      const kind = typeof record.kind === 'string' ? record.kind : '';
      return title ? `${title}${kind ? ` · ${kind}` : ''}` : '';
    })
    .filter(Boolean);
}

function formatRuntimeValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '未设置';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function getPrimaryCandidates(run: DBHarnessGepaRun) {
  const promptCandidate = run.candidateSet.find((candidate) => candidate.kind === 'prompt') || null;
  const policyCandidate = run.candidateSet.find((candidate) => candidate.kind === 'policy') || null;
  return [promptCandidate, policyCandidate].filter((item): item is DBHarnessGepaCandidate => Boolean(item));
}

function buildRuntimeConfigPreview(
  current: DBHarnessRuntimeConfig | undefined,
  run: DBHarnessGepaRun
) {
  const before = { ...(current || {}) };
  const after = { ...before } as DBHarnessRuntimeConfig;
  const appliedCandidates = getPrimaryCandidates(run);

  appliedCandidates.forEach((candidate) => {
    if (candidate.compressionLevel) {
      after.preferredCompressionLevel = candidate.compressionLevel;
    }
    if (candidate.promptPatch) {
      after.promptStrategy = candidate.promptPatch;
    }
    if (typeof candidate.nerTopK === 'number' && Number.isFinite(candidate.nerTopK)) {
      after.nerCandidateLimit = Math.max(8, Math.min(Math.trunc(candidate.nerTopK), 32));
    }
    const schemaOverviewTables = candidate.policyPatch?.schemaOverviewTables;
    if (typeof schemaOverviewTables === 'number' && Number.isFinite(schemaOverviewTables)) {
      after.schemaOverviewTables = Math.max(2, Math.min(Math.trunc(schemaOverviewTables), 12));
    }
  });

  after.source = 'gepa';
  after.appliedRunId = run.id;
  after.appliedCandidateIds = appliedCandidates.map((candidate) => candidate.id);
  after.updatedAt = new Date().toISOString();

  const diffs: DBHarnessRuntimeConfigDiffEntry[] = [
    {
      key: 'preferredCompressionLevel',
      label: '默认压缩级别',
      before: formatRuntimeValue(before.preferredCompressionLevel),
      after: formatRuntimeValue(after.preferredCompressionLevel),
    },
    {
      key: 'nerCandidateLimit',
      label: 'NER 候选上限',
      before: formatRuntimeValue(before.nerCandidateLimit),
      after: formatRuntimeValue(after.nerCandidateLimit),
    },
    {
      key: 'schemaOverviewTables',
      label: 'Schema 摘要表数',
      before: formatRuntimeValue(before.schemaOverviewTables),
      after: formatRuntimeValue(after.schemaOverviewTables),
    },
    {
      key: 'promptStrategy',
      label: 'Prompt 策略',
      before: formatRuntimeValue(before.promptStrategy),
      after: formatRuntimeValue(after.promptStrategy),
    },
  ].filter((item): item is DBHarnessRuntimeConfigDiffEntry => item.before !== item.after);

  return {
    before,
    after,
    diffs,
    candidateLabels: appliedCandidates.map((candidate) => `${candidate.title} · ${candidate.kind}`),
  };
}

function statusClassName(status: DBHarnessGepaRun['status']) {
  if (status === 'running') return styles.statusRunning;
  if (status === 'reviewed') return styles.statusReviewed;
  if (status === 'applied') return styles.statusApplied;
  if (status === 'failed') return styles.statusFailed;
  return styles.statusDraft;
}

export default function GepaPage() {
  const [workspaces, setWorkspaces] = useState<DBHarnessWorkspaceRecord[]>([]);
  const [databases, setDatabases] = useState<DatabaseInstanceSummary[]>([]);
  const [runs, setRuns] = useState<DBHarnessGepaRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [applyingRunId, setApplyingRunId] = useState<string | null>(null);
  const [applyPreview, setApplyPreview] = useState<{
    run: DBHarnessGepaRun;
    workspaceId: string;
    before: DBHarnessRuntimeConfig;
    after: DBHarnessRuntimeConfig;
    diffs: DBHarnessRuntimeConfigDiffEntry[];
    candidateLabels: string[];
  } | null>(null);
  const [deletePreview, setDeletePreview] = useState<DBHarnessGepaRun | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [createDraft, setCreateDraft] = useState({
    workspaceId: '',
    databaseId: '',
    sampleLimit: 12,
    promptCandidateCount: 2,
    policyCandidateCount: 3,
  });

  const selectedRun = useMemo(
    () => runs.find((item) => item.id === selectedRunId) || runs[0] || null,
    [runs, selectedRunId]
  );
  const selectedWorkspace = useMemo(
    () => workspaces.find((item) => item.id === createDraft.workspaceId) || null,
    [createDraft.workspaceId, workspaces]
  );
  const selectedRunWorkspace = useMemo(
    () => workspaces.find((item) => item.id === selectedRun?.workspaceId) || null,
    [selectedRun?.workspaceId, workspaces]
  );
  const selectedRunDatabase = useMemo(
    () => databases.find((item) => item.id === selectedRun?.databaseId) || null,
    [selectedRun?.databaseId, databases]
  );
  const runtimeConfigDiff = useMemo(() => parseRuntimeConfigDiff(selectedRun), [selectedRun]);
  const runtimeConfigBefore = useMemo(() => parseRuntimeConfigSnapshot(selectedRun, 'runtimeConfigBefore'), [selectedRun]);
  const runtimeConfigAfter = useMemo(() => parseRuntimeConfigSnapshot(selectedRun, 'runtimeConfigAfter'), [selectedRun]);
  const appliedCandidateLabels = useMemo(() => parseAppliedCandidateLabels(selectedRun), [selectedRun]);

  async function loadDependencies() {
    const [workspaceRes, databaseRes] = await Promise.all([
      fetch('/api/db-harness/workspaces', { cache: 'no-store' }),
      fetch('/api/database-instances', { cache: 'no-store' }),
    ]);

    if (workspaceRes.ok) {
      const workspaceData = await workspaceRes.json() as DBHarnessWorkspaceRecord[];
      setWorkspaces(Array.isArray(workspaceData) ? workspaceData : []);
    }

    if (databaseRes.ok) {
      const databaseData = await databaseRes.json() as DatabaseInstanceSummary[];
      setDatabases(Array.isArray(databaseData) ? databaseData : []);
    }
  }

  async function loadRuns() {
    const response = await fetch('/api/db-harness/gepa/runs?limit=50', { cache: 'no-store' });
    const payload = await response.json() as GepaListResponse;
    if (!response.ok || !('runs' in payload)) {
      throw new Error('读取 GEPA 任务失败');
    }
    setRuns(payload.runs || []);
    setSelectedRunId((current) => current || payload.runs[0]?.id || '');
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        await Promise.all([loadDependencies(), loadRuns()]);
        if (!active) return;
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : '读取 GEPA 工作台失败');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (createDraft.workspaceId) return;
    const firstWorkspace = workspaces[0];
    const firstDatabase = databases[0];
    setCreateDraft((current) => ({
      ...current,
      workspaceId: firstWorkspace?.id || '',
      databaseId: firstWorkspace?.databaseId || firstDatabase?.id || '',
    }));
  }, [workspaces, databases, createDraft.workspaceId]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    setCreateDraft((current) => ({
      ...current,
      databaseId: selectedWorkspace.databaseId || current.databaseId || databases[0]?.id || '',
    }));
  }, [selectedWorkspace, databases]);

  async function refreshRuns() {
    setRefreshing(true);
    setErrorMessage('');
    try {
      await loadRuns();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '刷新 GEPA 任务失败');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCreateRun() {
    if (!createDraft.databaseId) {
      setErrorMessage('请先选择数据库。');
      return;
    }

    setCreating(true);
    setErrorMessage('');
    try {
      const response = await fetch('/api/db-harness/gepa/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createDraft),
      });
      const payload = await response.json() as GepaCreateResponse;
      if (!response.ok || !('run' in payload)) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : '创建 GEPA 任务失败');
      }
      setRuns((current) => [payload.run, ...current.filter((item) => item.id !== payload.run.id)]);
      setSelectedRunId(payload.run.id);
      await refreshRuns();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '创建 GEPA 任务失败');
    } finally {
      setCreating(false);
    }
  }

  function openApplyPreview(run: DBHarnessGepaRun) {
    if (!run.workspaceId) {
      setErrorMessage('当前 Run 未指定所属 Workspace，无法应用。请重新创建 Run 并指定 Workspace。');
      return;
    }

    const workspace = workspaces.find((item) => item.id === run.workspaceId);

    if (!workspace) {
      setErrorMessage('当前 Run 所属的 Workspace 不存在，无法应用。');
      return;
    }

    setApplyPreview({
      run,
      workspaceId: workspace.id,
      ...buildRuntimeConfigPreview(workspace.runtimeConfig, run),
    });
  }

  async function handleApplyRun(runId: string) {
    setApplyingRunId(runId);
    setErrorMessage('');
    try {
      const response = await fetch(`/api/db-harness/gepa/runs/${runId}/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ approvedBy: 'ui' }),
      });
      const payload = await response.json() as GepaApplyResponse;
      if (!response.ok || !('run' in payload)) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : '应用 GEPA 任务失败');
      }
      setRuns((current) => current.map((item) => (item.id === payload.run.id ? payload.run : item)));
      if ('workspace' in payload && payload.workspace) {
        setWorkspaces((current) => current.map((item) => (item.id === payload.workspace?.id ? payload.workspace : item)));
      }
      setApplyPreview(null);
      setSelectedRunId(payload.run.id);
      await refreshRuns();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '应用 GEPA 任务失败');
    } finally {
      setApplyingRunId(null);
    }
  }

  async function confirmApplyPreview() {
    if (!applyPreview) return;
    await handleApplyRun(applyPreview.run.id);
  }

  function openDeletePreview(run: DBHarnessGepaRun) {
    setDeletePreview(run);
  }

  async function handleDeleteRun(runId: string) {
    setErrorMessage('');
    try {
      const response = await fetch(`/api/db-harness/gepa/runs/${runId}`, {
        method: 'DELETE',
      });
      const payload = await response.json() as GepaDeleteResponse;
      if (!response.ok || !('success' in payload)) {
        throw new Error(payload && 'error' in payload && payload.error ? payload.error : '删除 GEPA 任务失败');
      }
      setRuns((current) => {
        const next = current.filter((item) => item.id !== runId);
        if (selectedRunId === runId) {
          setSelectedRunId(next[0]?.id || '');
        }
        return next;
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '删除 GEPA 任务失败');
    }
  }

  async function confirmDeletePreview() {
    if (!deletePreview) return;
    const runId = deletePreview.id;
    setDeletePreview(null);
    await handleDeleteRun(runId);
  }

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>GEPA Workbench</p>
          <h1 className={styles.title}>Prompt + Policy 离线评估工作台</h1>
          <p className={styles.subtitle}>
            用离线回放比较 baseline 与 candidate，审核通过后再应用到 DB Harness 主链路。
          </p>
        </div>

        <div className={styles.heroActions}>
          <Link href="/db-harness" className="btn btn-secondary btn-sm">
            返回对话页
          </Link>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void refreshRuns()} disabled={refreshing}>
            <Icons.Refresh size={14} />
            {refreshing ? '刷新中...' : '刷新任务'}
          </button>
        </div>
      </header>

      {errorMessage ? <div className={styles.errorBanner}><Icons.AlertTriangle size={16} />{errorMessage}</div> : null}

      <section className={styles.controlGrid}>
        <div className={styles.controlCard}>
          <div className={styles.cardHeader}>
            <div>
              <div className={styles.cardLabel}>创建任务</div>
              <h2 className={styles.cardTitle}>离线回放 + 人工审核</h2>
            </div>
            <span className={styles.cardMeta}>{workspaces.length} 个 workspace · {databases.length} 个数据源</span>
          </div>

          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>Workspace</span>
              <select
                className="form-select"
                value={createDraft.workspaceId}
                onChange={(event) => setCreateDraft((current) => ({ ...current, workspaceId: event.target.value }))}
              >
                <option value="">不绑定 Workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}{workspace.databaseId ? ` · ${workspace.databaseId}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span>数据库</span>
              <select
                className="form-select"
                value={createDraft.databaseId}
                onChange={(event) => setCreateDraft((current) => ({ ...current, databaseId: event.target.value }))}
              >
                <option value="">请选择数据源</option>
                {databases.map((database) => (
                  <option key={database.id} value={database.id}>
                    {database.name} · {database.type}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span>样本数</span>
              <input
                className="form-input"
                type="number"
                min={1}
                max={20}
                value={createDraft.sampleLimit}
                onChange={(event) => setCreateDraft((current) => ({ ...current, sampleLimit: Number(event.target.value) || 12 }))}
              />
            </label>

            <label className={styles.field}>
              <span>Prompt 候选</span>
              <input
                className="form-input"
                type="number"
                min={1}
                max={6}
                value={createDraft.promptCandidateCount}
                onChange={(event) => setCreateDraft((current) => ({ ...current, promptCandidateCount: Number(event.target.value) || 2 }))}
              />
            </label>

            <label className={styles.field}>
              <span>Policy 候选</span>
              <input
                className="form-input"
                type="number"
                min={1}
                max={6}
                value={createDraft.policyCandidateCount}
                onChange={(event) => setCreateDraft((current) => ({ ...current, policyCandidateCount: Number(event.target.value) || 3 }))}
              />
            </label>
          </div>

          <div className={styles.formFooter}>
            <p className={styles.helperText}>
              第一版使用 heuristic 回放生成候选与评分，后续可无缝替换成真实 LLM replay。
            </p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleCreateRun()} disabled={creating}>
              <Icons.Sparkles size={14} />
              {creating ? '生成中...' : '运行 GEPA'}
            </button>
          </div>
        </div>
      </section>

      <section className={styles.workspaceLayout}>
        <aside className={styles.runListPanel}>
          <div className={styles.cardHeader}>
            <div>
              <div className={styles.cardLabel}>任务列表</div>
              <h2 className={styles.cardTitle}>Run History</h2>
            </div>
            <span className={styles.cardMeta}>{runs.length} 条记录</span>
          </div>

          <div className={styles.runList}>
            {loading ? (
              <div className={styles.emptyState}>加载中...</div>
            ) : runs.length === 0 ? (
              <div className={styles.emptyState}>还没有 GEPA 任务，先创建一个。</div>
            ) : runs.map((run) => {
              const active = run.id === selectedRun?.id;
              const workspaceLabel = workspaces.find((item) => item.id === run.workspaceId)?.name || run.workspaceId || '未绑定 workspace';
              const databaseLabel = databases.find((item) => item.id === run.databaseId)?.name || run.databaseId;
              return (
                <article key={run.id} className={`${styles.runCard} ${active ? styles.runCardActive : ''}`}>
                  <button
                    type="button"
                    className={styles.runCardMain}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <div className={styles.runCardTop}>
                      <div>
                        <div className={styles.runTitle}>{databaseLabel}</div>
                        <div className={styles.runSubTitle}>{workspaceLabel} · {run.datasetVersion || '未记录数据版本'}</div>
                      </div>
                      <span className={`${styles.statusBadge} ${statusClassName(run.status)}`}>
                        {run.status}
                      </span>
                    </div>
                    <div className={styles.runCardMeta}>
                      <span>{run.samples.length} 个样本</span>
                      <span>{run.candidateSet.length} 个候选</span>
                      <span>{run.scoreCard.balancedScore.toFixed(2)}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={styles.runDeleteButton}
                    onClick={() => openDeletePreview(run)}
                    aria-label="删除 GEPA Run"
                  >
                    <Icons.Trash size={14} />
                  </button>
                </article>
              );
            })}
          </div>
        </aside>

        <main className={styles.detailPanel}>
          {!selectedRun ? (
            <div className={styles.emptyStage}>
              <h2 className={styles.emptyTitle}>选择一个 GEPA Run 查看详情</h2>
              <p className={styles.emptyHint}>这里会展示候选、样本对比和审核入口。</p>
            </div>
          ) : (
            <>
              <section className={styles.detailHero}>
                <div>
                  <div className={styles.cardLabel}>Run Detail</div>
                  <h2 className={styles.detailTitle}>{selectedRunDatabase?.name || selectedRun.databaseId}</h2>
                  <p className={styles.detailSubtitle}>
                    {selectedRunWorkspace?.name || '未绑定 workspace'} · {selectedRun.datasetVersion || '未记录数据版本'}
                  </p>
                </div>
                <div className={styles.detailActions}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => openDeletePreview(selectedRun)}
                  >
                    <Icons.Trash size={14} />
                    删除 Run
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => openApplyPreview(selectedRun)}
                    disabled={selectedRun.status === 'applied' || applyingRunId === selectedRun.id}
                  >
                    <Icons.Check size={14} />
                    {selectedRun.status === 'applied' ? '已应用' : applyingRunId === selectedRun.id ? '应用中...' : '应用候选'}
                  </button>
                  <Link href={`/api/db-harness/gepa/runs/${selectedRun.id}`} className="btn btn-secondary btn-sm" target="_blank">
                    <Icons.ExternalLink size={14} />
                    查看 API
                  </Link>
                </div>
              </section>

              <section className={styles.summaryGrid}>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Balanced Score</div>
                  <div className={styles.summaryValue}>{selectedRun.scoreCard.balancedScore.toFixed(2)}</div>
                  <div className={styles.summaryHint}>相对 baseline：{scoreTrend(selectedRun.scoreCard)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>SQL 成功率</div>
                  <div className={styles.summaryValue}>{formatPercent(selectedRun.scoreCard.sqlSuccessRate)}</div>
                  <div className={styles.summaryHint}>Empty Rate {formatPercent(selectedRun.scoreCard.emptyRate)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>平均延迟</div>
                  <div className={styles.summaryValue}>{formatNumber(selectedRun.scoreCard.latencyAvgMs)} ms</div>
                  <div className={styles.summaryHint}>P95 {formatNumber(selectedRun.scoreCard.latencyP95Ms)} ms</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Token Cost</div>
                  <div className={styles.summaryValue}>{formatNumber(selectedRun.scoreCard.tokenCost)}</div>
                  <div className={styles.summaryHint}>候选总数 {selectedRun.candidateSet.length}</div>
                </div>
              </section>

              {(runtimeConfigDiff.length > 0 || runtimeConfigBefore || runtimeConfigAfter) ? (
                <section className={styles.blockCard}>
                  <div className={styles.cardHeader}>
                    <div>
                      <div className={styles.cardLabel}>运行时配置</div>
                      <h3 className={styles.cardTitle}>应用前后配置对比</h3>
                    </div>
                    <span className={styles.cardMeta}>{runtimeConfigDiff.length} 项变更</span>
                  </div>

                  {appliedCandidateLabels.length > 0 ? (
                    <div className={styles.noteChips}>
                      {appliedCandidateLabels.map((label) => (
                        <span key={label} className={styles.noteChip}>{label}</span>
                      ))}
                    </div>
                  ) : null}

                  {runtimeConfigDiff.length > 0 ? (
                    <div className={styles.configDiffList}>
                      {runtimeConfigDiff.map((item) => (
                        <article key={item.key} className={styles.configDiffItem}>
                          <div className={styles.configDiffLabel}>{item.label}</div>
                          <div className={styles.configDiffValues}>
                            <div className={styles.configDiffColumn}>
                              <span className={styles.configDiffTag}>Before</span>
                              <code className={styles.configDiffCode}>{item.before}</code>
                            </div>
                            <div className={styles.configDiffColumn}>
                              <span className={styles.configDiffTag}>After</span>
                              <code className={styles.configDiffCode}>{item.after}</code>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}

                  <div className={styles.configSnapshotGrid}>
                    <div className={styles.configSnapshotCard}>
                      <div className={styles.sampleCompareLabel}>Before</div>
                      <pre className={styles.configSnapshotCode}>{JSON.stringify(runtimeConfigBefore || {}, null, 2)}</pre>
                    </div>
                    <div className={styles.configSnapshotCard}>
                      <div className={styles.sampleCompareLabel}>After</div>
                      <pre className={styles.configSnapshotCode}>{JSON.stringify(runtimeConfigAfter || {}, null, 2)}</pre>
                    </div>
                  </div>
                </section>
              ) : null}

              <section className={styles.blockCard}>
                <div className={styles.cardHeader}>
                  <div>
                    <div className={styles.cardLabel}>候选集</div>
                    <h3 className={styles.cardTitle}>Prompt / Policy</h3>
                  </div>
                  <span className={styles.cardMeta}>{selectedRun.candidateSet.length} 个候选</span>
                </div>

                <div className={styles.candidateGrid}>
                  {selectedRun.candidateSet.map((candidate, index) => (
                    <article key={candidate.id || `${candidate.kind}-${index}`} className={styles.candidateCard}>
                      <div className={styles.candidateTop}>
                        <div>
                          <div className={styles.candidateKind}>{candidateKindLabel(candidate)}</div>
                          <div className={styles.candidateTitle}>{candidate.title}</div>
                        </div>
                        {candidate.compressionLevel ? (
                          <span className={styles.candidateBadge}>{candidate.compressionLevel}</span>
                        ) : null}
                      </div>
                      <p className={styles.candidateDesc}>{candidate.description}</p>
                      {candidate.nerTopK ? (
                        <div className={styles.noteChips}>
                          <span className={styles.noteChip}>NER topK {candidate.nerTopK}</span>
                          {candidate.compressionLevel ? <span className={styles.noteChip}>{candidate.compressionLevel}</span> : null}
                        </div>
                      ) : null}
                      {candidate.promptPatch ? (
                        <pre className={styles.candidateCode}>{candidate.promptPatch}</pre>
                      ) : null}
                      {candidate.policyPatch ? (
                        <pre className={styles.candidateCode}>{JSON.stringify(candidate.policyPatch, null, 2)}</pre>
                      ) : null}
                      {candidate.notes?.length ? (
                        <div className={styles.noteChips}>
                          {candidate.notes.map((note) => (
                            <span key={`${candidate.id}-${note}`} className={styles.noteChip}>{note}</span>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>

              <section className={styles.blockCard}>
                <div className={styles.cardHeader}>
                  <div>
                    <div className={styles.cardLabel}>样本对比</div>
                    <h3 className={styles.cardTitle}>Baseline vs Candidate</h3>
                  </div>
                  <span className={styles.cardMeta}>{selectedRun.samples.length} 个样本</span>
                </div>

                <div className={styles.sampleList}>
                  {selectedRun.samples.map((sample) => (
                    <article key={sample.sampleId} className={styles.sampleCard}>
                      <div className={styles.sampleQuestion}>{sample.question}</div>
                      <div className={styles.sampleCompare}>
                        <div className={styles.sampleCompareCard}>
                          <div className={styles.sampleCompareLabel}>Baseline</div>
                          <div className={styles.sampleCompareStatus}>{sample.baseline.status}</div>
                          <div className={styles.sampleCompareMeta}>{sample.baseline.detail}</div>
                          <div className={styles.sampleCompareMeta}>{formatNumber(sample.baseline.latencyMs)} ms · {formatNumber(sample.baseline.tokenCost)} tokens</div>
                        </div>
                        <div className={styles.sampleCompareCard}>
                          <div className={styles.sampleCompareLabel}>Candidate</div>
                          <div className={styles.sampleCompareStatus}>{sample.candidate.status}</div>
                          <div className={styles.sampleCompareMeta}>{sample.candidate.detail}</div>
                          <div className={styles.sampleCompareMeta}>{formatNumber(sample.candidate.latencyMs)} ms · {formatNumber(sample.candidate.tokenCost)} tokens</div>
                        </div>
                      </div>
                      <div className={styles.sampleDelta}>
                        <span>Score Δ {sample.delta.score.toFixed(2)}</span>
                        <span>Latency Δ {formatNumber(sample.delta.latencyMs)} ms</span>
                        <span>Token Δ {formatNumber(sample.delta.tokenCost)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <details className={styles.rawBlock}>
                <summary>原始报告</summary>
                <pre>{JSON.stringify(selectedRun.report, null, 2)}</pre>
              </details>
            </>
          )}
        </main>
      </section>

      {deletePreview ? (
        <div
          className={styles.dialogOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="删除 GEPA Run"
          onClick={() => setDeletePreview(null)}
        >
          <div className={styles.dialogPanel} onClick={(event) => event.stopPropagation()}>
            <div className={styles.dialogHeader}>
              <div>
                <div className={styles.cardLabel}>删除 Run</div>
                <h3 className={styles.dialogTitle}>确认删除这条历史记录？</h3>
                <p className={styles.dialogHint}>
                  删除后这条 GEPA Run 及其评估记录将无法恢复，请先确认不再需要这份结果。
                </p>
              </div>
              <button type="button" className={styles.dialogClose} onClick={() => setDeletePreview(null)} aria-label="关闭">
                <Icons.X size={14} />
              </button>
            </div>

            <div className={styles.dialogSummary}>
              {deletePreview.workspaceId || deletePreview.databaseId ? (
                <>
                  {deletePreview.workspaceId ? `Workspace ${deletePreview.workspaceId}` : '未绑定 Workspace'}
                  {' · '}
                  {deletePreview.databaseId || '未绑定数据源'}
                  {' · '}
                  {deletePreview.samples.length} 个样本
                  {' · '}
                  {deletePreview.candidateSet.length} 个候选
                </>
              ) : (
                '这条记录不再需要时再执行删除。'
              )}
            </div>

            <div className={styles.configSnapshotGrid}>
              <div className={styles.configSnapshotCard}>
                <div className={styles.sampleCompareLabel}>当前状态</div>
                <div className={styles.configSnapshotMeta}>{deletePreview.status}</div>
                <div className={styles.configSnapshotMeta}>{deletePreview.scoreCard.balancedScore.toFixed(2)} Balanced Score</div>
              </div>
              <div className={styles.configSnapshotCard}>
                <div className={styles.sampleCompareLabel}>删除影响</div>
                <div className={styles.configSnapshotMeta}>会从 Run History 中移除，并清理相关视图。</div>
              </div>
            </div>

            <div className={styles.dialogFooter}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDeletePreview(null)}>
                取消
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void confirmDeletePreview()}>
                <Icons.Trash size={14} />
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {applyPreview ? (
        <div
          className={styles.dialogOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="应用候选前后配置对比"
          onClick={() => setApplyPreview(null)}
        >
          <div className={styles.dialogPanel} onClick={(event) => event.stopPropagation()}>
            <div className={styles.dialogHeader}>
                <div>
                  <div className={styles.cardLabel}>应用候选</div>
                  <h3 className={styles.dialogTitle}>确认保存前先看配置对比</h3>
                  <p className={styles.dialogHint}>
                    这次保存会把 GEPA 候选写入 Workspace 运行时配置，下面先看前后差异再确认。
                  </p>
                </div>
              <button type="button" className={styles.dialogClose} onClick={() => setApplyPreview(null)} aria-label="关闭">
                <Icons.X size={14} />
              </button>
            </div>

            {applyPreview.candidateLabels.length ? (
              <div className={styles.noteChips}>
                {applyPreview.candidateLabels.map((label) => (
                  <span key={label} className={styles.noteChip}>{label}</span>
                ))}
              </div>
            ) : null}

            <div className={styles.configSnapshotGrid}>
              <div className={styles.configSnapshotCard}>
                <div className={styles.sampleCompareLabel}>Before</div>
                <pre className={styles.configSnapshotCode}>{JSON.stringify(applyPreview.before, null, 2)}</pre>
              </div>
              <div className={styles.configSnapshotCard}>
                <div className={styles.sampleCompareLabel}>After</div>
                <pre className={styles.configSnapshotCode}>{JSON.stringify(applyPreview.after, null, 2)}</pre>
              </div>
            </div>

            {applyPreview.diffs.length ? (
              <div className={styles.dialogSummary}>
                将更新 {applyPreview.diffs.map((item) => item.label).join('、')}。
              </div>
            ) : (
              <div className={styles.dialogSummary}>
                本次候选不会改变运行时配置，只会标记为已应用。
              </div>
            )}

            {applyPreview.diffs.length ? (
              <div className={styles.configDiffList}>
                {applyPreview.diffs.map((item) => (
                  <article key={item.key} className={styles.configDiffItem}>
                    <div className={styles.configDiffLabel}>{item.label}</div>
                    <div className={styles.configDiffValues}>
                      <div className={styles.configDiffColumn}>
                        <span className={styles.configDiffTag}>Before</span>
                        <code className={styles.configDiffCode}>{item.before}</code>
                      </div>
                      <div className={styles.configDiffColumn}>
                        <span className={styles.configDiffTag}>After</span>
                        <code className={styles.configDiffCode}>{item.after}</code>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}

            <div className={styles.dialogFooter}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setApplyPreview(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void confirmApplyPreview()}
                disabled={applyingRunId === applyPreview.run.id}
              >
                <Icons.Check size={14} />
                {applyingRunId === applyPreview.run.id ? '保存中...' : '确认并保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { buildAiChatEndpoint } from '@/lib/ai-models';
import {
  getAllAIModelProfiles,
  getDatabaseInstanceById,
  getDBHarnessWorkspaceById,
  getDBHarnessWorkspaces,
} from '@/lib/db';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import {
  DBHarnessGepaApplyRequest,
  DBHarnessGepaCandidate,
  DBHarnessGepaCreateRequest,
  DBHarnessCatalogSnapshot,
  DBHarnessSemanticSnapshot,
  DBHarnessGepaRun,
  DBHarnessGepaSampleResult,
  DBHarnessGepaScoreCard,
  DBHarnessRuntimeConfig,
  DBHarnessRuntimeConfigDiffEntry,
  DBHarnessSessionContext,
  DBHarnessWorkspaceContext,
} from '../core/types';
import { buildKeywordSet } from '../core/utils';
import { deriveCatalogSnapshot, deriveSemanticSnapshot } from '../tools/catalog-tools';
import {
  buildFallbackNerPayload,
  buildFallbackPlanningHints,
  buildFallbackQueryPlan,
  buildNerCandidateBundle,
  buildQueryPromptContext,
} from '../tools/planning-tools';
import {
  createDBHarnessGepaRun,
  deleteDBHarnessGepaRun,
  getDBHarnessGepaRunById,
  listDBHarnessGepaRuns,
  updateDBHarnessWorkspace,
  updateDBHarnessGepaRun,
} from '@/lib/db';

interface GepaPolicyCandidate extends DBHarnessGepaCandidate {
  compressionLevel: 'standard' | 'compact' | 'minimal';
  nerTopK: number;
}

function formatRuntimeConfigValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '未设置';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function buildRuntimeConfigDiff(before: DBHarnessRuntimeConfig, after: DBHarnessRuntimeConfig): DBHarnessRuntimeConfigDiffEntry[] {
  const fields: Array<Pick<DBHarnessRuntimeConfigDiffEntry, 'key' | 'label'>> = [
    { key: 'preferredCompressionLevel', label: '默认压缩级别' },
    { key: 'nerCandidateLimit', label: 'NER 候选上限' },
    { key: 'schemaOverviewTables', label: 'Schema 摘要表数' },
    { key: 'promptStrategy', label: 'Prompt 策略' },
  ];

  return fields.reduce<DBHarnessRuntimeConfigDiffEntry[]>((list, field) => {
    const beforeValue = before[field.key];
    const afterValue = after[field.key];
    if (JSON.stringify(beforeValue ?? null) === JSON.stringify(afterValue ?? null)) {
      return list;
    }
    list.push({
      key: field.key,
      label: field.label,
      before: formatRuntimeConfigValue(beforeValue),
      after: formatRuntimeConfigValue(afterValue),
    });
    return list;
  }, []);
}

function selectApplicableCandidates(run: DBHarnessGepaRun): GepaPolicyCandidate[] {
  const promptCandidate = run.candidateSet.find((candidate) => candidate.kind === 'prompt') || null;
  const policyCandidate = run.candidateSet.find((candidate) => candidate.kind === 'policy') || null;
  return [promptCandidate, policyCandidate].filter((item): item is GepaPolicyCandidate => Boolean(item));
}

function buildAppliedRuntimeConfig(
  current: DBHarnessRuntimeConfig,
  candidates: GepaPolicyCandidate[],
  runId: string
) {
  const next: DBHarnessRuntimeConfig = { ...current };
  const appliedCandidateIds: string[] = [];

  candidates.forEach((candidate) => {
    appliedCandidateIds.push(candidate.id);
    if (candidate.compressionLevel) {
      next.preferredCompressionLevel = candidate.compressionLevel;
    }
    if (candidate.promptPatch) {
      next.promptStrategy = candidate.promptPatch;
    }
    if (typeof candidate.nerTopK === 'number' && Number.isFinite(candidate.nerTopK)) {
      next.nerCandidateLimit = Math.max(8, Math.min(Math.trunc(candidate.nerTopK), 32));
    }
    const schemaOverviewTables = candidate.policyPatch?.schemaOverviewTables;
    if (typeof schemaOverviewTables === 'number' && Number.isFinite(schemaOverviewTables)) {
      next.schemaOverviewTables = Math.max(2, Math.min(Math.trunc(schemaOverviewTables), 12));
    }
  });

  next.source = 'gepa';
  next.appliedRunId = runId;
  next.appliedCandidateIds = appliedCandidateIds;
  next.updatedAt = new Date().toISOString();

  return {
    before: current,
    after: next,
    diff: buildRuntimeConfigDiff(current, next),
    appliedCandidateIds,
  };
}

function resolveEvaluationModelContext() {
  const profile = getAllAIModelProfiles()[0] || null;
  const fallbackProfile = {
    id: 'gepa-placeholder',
    name: 'GEPA Placeholder',
    modelType: 'chat',
    baseUrl: 'http://127.0.0.1',
    authType: 'none',
    modelIds: ['gepa-placeholder'],
    defaultModelId: 'gepa-placeholder',
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies DBHarnessWorkspaceContext['profile'];

  if (!profile) {
    return {
      profile: fallbackProfile,
      selectedModel: {
        profileId: fallbackProfile.id,
        modelId: fallbackProfile.defaultModelId,
      },
      endpoint: buildAiChatEndpoint(fallbackProfile.baseUrl) || fallbackProfile.baseUrl,
    };
  }
  const modelId = profile.defaultModelId || profile.modelIds[0] || fallbackProfile.defaultModelId;
  return {
    profile,
    selectedModel: {
      profileId: profile.id,
      modelId,
    },
    endpoint: buildAiChatEndpoint(profile.baseUrl) || profile.baseUrl,
  };
}

function latestUserMessage(session: DBHarnessSessionContext['messages']) {
  return session.filter((message) => message.role === 'user').at(-1)?.content?.trim() || '';
}

function extractSamples(input: {
  workspaceId?: string;
  databaseId: string;
  sampleLimit: number;
  workspaceRules: string;
}): Array<{ sampleId: string; question: string }> {
  const workspace = input.workspaceId ? getDBHarnessWorkspaceById(input.workspaceId) : null;
  const sessions = workspace?.sessions
    .filter((session) => !session.selectedDatabaseId || session.selectedDatabaseId === input.databaseId)
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt))
    .slice(0, input.sampleLimit) || [];

  const sessionSamples = sessions
    .map((session) => {
      const question = latestUserMessage(session.messages);
      if (!question) return null;
      return {
        sampleId: session.id,
        question,
      };
    })
    .filter((item): item is { sampleId: string; question: string } => Boolean(item));

  if (sessionSamples.length > 0) {
    return sessionSamples.slice(0, input.sampleLimit);
  }

  return [];
}

function buildSyntheticSamples(input: {
  catalog: DBHarnessCatalogSnapshot;
  semantic: DBHarnessSemanticSnapshot;
  sampleLimit: number;
}) {
  const samples: Array<{ sampleId: string; question: string }> = [];
  const focusTables = input.catalog.entities.slice(0, 4);
  const focusSemantic = input.semantic.entities.slice(0, 4);

  focusTables.forEach((entity, index) => {
    if (samples.length >= input.sampleLimit) return;
    const metric = focusSemantic[index]?.metrics[0] || focusSemantic[0]?.metrics[0] || '核心指标';
    const dimension = focusSemantic[index]?.dimensions[0] || '维度';
    samples.push({
      sampleId: `synthetic-${index + 1}`,
      question: `请分析 ${entity.name} 的 ${metric}，并按 ${dimension} 展开。`,
    });
  });

  while (samples.length < input.sampleLimit) {
    const fallbackTable = focusTables[samples.length % Math.max(focusTables.length, 1)]?.name || '核心数据表';
    samples.push({
      sampleId: `synthetic-${samples.length + 1}`,
      question: `查询 ${fallbackTable} 最近 7 天的核心指标变化。`,
    });
  }

  return samples;
}

function buildOfflineWorkspaceContext(input: {
  workspaceId?: string;
  workspaceRules: string;
  databaseInstance: NonNullable<ReturnType<typeof getDatabaseInstanceById>>;
  schema: Awaited<ReturnType<typeof getDatabaseSchema>>;
  metricMappings: ReturnType<typeof getEffectiveDatabaseMetricMappings>;
  catalog: DBHarnessCatalogSnapshot;
  semantic: DBHarnessSemanticSnapshot;
  knowledge: DBHarnessWorkspaceContext['knowledge'];
}): DBHarnessWorkspaceContext {
  const modelContext = resolveEvaluationModelContext();
  return {
    workspaceId: input.workspaceId,
    workspaceRules: input.workspaceRules,
    databaseInstance: input.databaseInstance,
    profile: modelContext.profile,
    selectedModel: modelContext.selectedModel,
    endpoint: modelContext.endpoint,
    schema: input.schema,
    metricMappings: input.metricMappings,
    catalog: input.catalog,
    semantic: input.semantic,
    knowledge: input.knowledge,
  } satisfies DBHarnessWorkspaceContext;
}

function buildPolicyCandidates(promptCandidateCount: number, policyCandidateCount: number): GepaPolicyCandidate[] {
  const promptCandidates: GepaPolicyCandidate[] = [
    {
      id: 'prompt-balanced',
      kind: 'prompt',
      title: '平衡型 Prompt',
      description: '保留标准上下文层级，优先确保字段与规则完整。',
      promptPatch: '保留 Intent / Schema / Query 三层结构，偏向完整语义上下文。',
      notes: ['适用于高准确率优先场景'],
      compressionLevel: 'standard',
      nerTopK: 24,
    },
    {
      id: 'prompt-compact',
      kind: 'prompt',
      title: '紧凑型 Prompt',
      description: '减少冗余上下文，优先保留最近会话与高相关字段。',
      promptPatch: '强化最近问题与结果摘要，压缩低相关目录信息。',
      notes: ['适用于长会话与高 token 压力场景'],
      compressionLevel: 'compact',
      nerTopK: 20,
    },
    {
      id: 'prompt-minimal',
      kind: 'prompt',
      title: '最小化 Prompt',
      description: '更激进的上下文压缩，适合超长上下文回放。',
      promptPatch: '只保留最核心规则、规划提示和字段摘要。',
      notes: ['适用于超长上下文兜底'],
      compressionLevel: 'minimal',
      nerTopK: 16,
    },
  ];

  const policyCandidates: GepaPolicyCandidate[] = [
    {
      id: 'policy-ner-wide',
      kind: 'policy',
      title: 'NER 扩容',
      description: '把高相关字段候选上限提高到 24，提升召回。',
      policyPatch: { nerTopK: 24, schemaOverviewTables: 8 },
      notes: ['更适合字段同义词较多的数据源'],
      compressionLevel: 'standard',
      nerTopK: 24,
    },
    {
      id: 'policy-ner-balanced',
      kind: 'policy',
      title: 'NER 平衡',
      description: '保留 20 个候选，兼顾召回与提示长度。',
      policyPatch: { nerTopK: 20, schemaOverviewTables: 6 },
      notes: ['适合作为默认候选'],
      compressionLevel: 'compact',
      nerTopK: 20,
    },
    {
      id: 'policy-ner-strict',
      kind: 'policy',
      title: 'NER 收敛',
      description: '更小的候选集，减少 prompt 噪音。',
      policyPatch: { nerTopK: 16, schemaOverviewTables: 4 },
      notes: ['适合特别长的问句'],
      compressionLevel: 'minimal',
      nerTopK: 16,
    },
  ];

  return [...promptCandidates.slice(0, promptCandidateCount), ...policyCandidates.slice(0, policyCandidateCount)];
}

function estimatePromptScore(input: {
  question: string;
  workspace: DBHarnessWorkspaceContext;
  candidate: GepaPolicyCandidate;
  sampleId: string;
  schema: Awaited<ReturnType<typeof getDatabaseSchema>>;
}) {
  const engine = input.workspace.databaseInstance.type as 'mysql' | 'pgsql';
  const keywords = buildKeywordSet(input.question, input.workspace.workspaceRules || '', input.workspace.databaseInstance.name);
  const nerBundle = buildNerCandidateBundle(input.schema, input.workspace.metricMappings, keywords);
  const effectiveTopK = Math.min(input.candidate.nerTopK, nerBundle.candidateCount || nerBundle.totalAvailable);
  const nerPayload = buildFallbackNerPayload(input.question, input.schema, input.workspace.metricMappings);
  const planningHints = buildFallbackPlanningHints(input.question, input.workspace);
  const adjustedNerPayload = {
    ...nerPayload,
    matchedMetrics: nerPayload.matchedMetrics.slice(0, effectiveTopK),
  };
  const adjustedPlanningHints = {
    ...planningHints,
    notes: [...planningHints.notes, input.candidate.description].slice(0, 6),
  };

  let baselineDetail = '规则引擎未能稳定规划';
  let candidateDetail = '规则引擎未能稳定规划';
  let baselineStatus: 'success' | 'empty' | 'error' = 'error';
  let candidateStatus: 'success' | 'empty' | 'error' = 'error';

  try {
    buildFallbackQueryPlan(input.question, engine, input.workspace, nerPayload, planningHints);
    baselineStatus = nerBundle.candidateCount > 0 ? 'success' : 'empty';
    baselineDetail = '基线策略可完成当前问句的结构化规划。';
  } catch (error) {
    baselineDetail = error instanceof Error ? error.message : String(error);
  }

  try {
    buildFallbackQueryPlan(input.question, engine, input.workspace, adjustedNerPayload, adjustedPlanningHints);
    candidateStatus = effectiveTopK > 0 ? 'success' : 'empty';
    candidateDetail = `候选 ${input.candidate.title} 可完成当前问句的结构化规划。`;
  } catch (error) {
    candidateDetail = error instanceof Error ? error.message : String(error);
  }

  const sampleSession: DBHarnessSessionContext = {
    turnId: input.sampleId,
    startedAt: new Date().toISOString(),
    messages: [{ role: 'user', content: input.question }],
    latestUserMessage: input.question,
    currentSql: '',
    currentResult: null,
    recentQuestions: [input.question],
  };

  const baselinePrompt = buildQueryPromptContext(sampleSession, input.workspace, planningHints, nerPayload, 'standard');
  const candidatePrompt = buildQueryPromptContext(sampleSession, input.workspace, adjustedPlanningHints, adjustedNerPayload, input.candidate.compressionLevel);

  const baselineLatencyMs = Math.round(850 + baselinePrompt.length / 16 + nerBundle.candidateCount * 10);
  const candidateLatencyMs = Math.round(820 + candidatePrompt.length / 18 + effectiveTopK * 8 - (input.candidate.compressionLevel === 'minimal' ? 40 : input.candidate.compressionLevel === 'compact' ? 15 : 0));
  const baselineTokenCost = Math.round(baselinePrompt.length / 4);
  const candidateTokenCost = Math.round(candidatePrompt.length / 4);
  const baselineScore = Math.max(0,
    (baselineStatus === 'success' ? 100 : baselineStatus === 'empty' ? 50 : 10)
    + nerBundle.candidateCount * 1.5
    - baselineLatencyMs / 180
    - baselineTokenCost / 220
  );
  const candidateScore = Math.max(0,
    (candidateStatus === 'success' ? 100 : candidateStatus === 'empty' ? 50 : 10)
    + effectiveTopK * 1.8
    - candidateLatencyMs / 180
    - candidateTokenCost / 220
  );

  return {
    baseline: {
      status: baselineStatus,
      latencyMs: baselineLatencyMs,
      tokenCost: baselineTokenCost,
      score: baselineScore,
      detail: baselineDetail,
    },
    candidate: {
      status: candidateStatus,
      latencyMs: candidateLatencyMs,
      tokenCost: candidateTokenCost,
      score: candidateScore,
      detail: candidateDetail,
    },
    delta: {
      score: candidateScore - baselineScore,
      latencyMs: candidateLatencyMs - baselineLatencyMs,
      tokenCost: candidateTokenCost - baselineTokenCost,
    },
    promptChars: {
      baseline: baselinePrompt.length,
      candidate: candidatePrompt.length,
    },
    matchedCount: nerBundle.candidateCount,
    effectiveTopK,
  };
}

function buildScoreCard(results: DBHarnessGepaSampleResult[]): DBHarnessGepaScoreCard {
  const count = Math.max(results.length, 1);
  const avgLatency = results.reduce((total, item) => total + item.candidate.latencyMs, 0) / count;
  const avgTokenCost = results.reduce((total, item) => total + item.candidate.tokenCost, 0) / count;
  const avgScore = results.reduce((total, item) => total + item.candidate.score, 0) / count;
  const baselineAvgScore = results.reduce((total, item) => total + item.baseline.score, 0) / count;

  const latencyValues = results.map((item) => item.candidate.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.min(latencyValues.length - 1, Math.max(0, Math.ceil(latencyValues.length * 0.95) - 1));
  const p95 = latencyValues[p95Index] || 0;

  const successRate = results.filter((item) => item.candidate.status === 'success').length / count;
  const emptyRate = results.filter((item) => item.candidate.status === 'empty').length / count;

  return {
    sqlSuccessRate: Number(successRate.toFixed(3)),
    emptyRate: Number(emptyRate.toFixed(3)),
    latencyAvgMs: Math.round(avgLatency),
    latencyP95Ms: Math.round(p95),
    tokenCost: Math.round(avgTokenCost),
    balancedScore: Number(avgScore.toFixed(2)),
    baselineBalancedScore: Number(baselineAvgScore.toFixed(2)),
    notes: [
      '当前版本为离线 heuristic 回放，用于生成候选排序与人工审核报告。',
    ],
  };
}

export async function runGepaCreate(input: DBHarnessGepaCreateRequest): Promise<DBHarnessGepaRun> {
  const databaseInstance = getDatabaseInstanceById(input.databaseId);
  if (!databaseInstance) {
    throw new Error('GEPA 评估所选数据源不存在。');
  }

  if (!input.workspaceId) {
    throw new Error('必须指定 GEPA 评估所属的 Workspace。');
  }

  const workspaceRecord = getDBHarnessWorkspaceById(input.workspaceId);
  if (!workspaceRecord) {
    throw new Error('指定的 Workspace 不存在。');
  }

  const schema = await getDatabaseSchema(databaseInstance);
  const metricMappings = getEffectiveDatabaseMetricMappings({
    metricMappings: databaseInstance.metricMappings,
    semanticModel: databaseInstance.semanticModel,
  });
  const catalog = deriveCatalogSnapshot(schema, metricMappings);
  const semantic = sanitizeDatabaseSemanticModel(databaseInstance.semanticModel) || deriveSemanticSnapshot(schema, metricMappings);
  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql') {
    throw new Error('GEPA 离线评估暂时仅支持 MySQL 和 PostgreSQL 数据源。');
  }
  const workspaceRules = workspaceRecord.rules || '';
  const knowledge: DBHarnessWorkspaceContext['knowledge'] = [];
  const evaluationWorkspace = buildOfflineWorkspaceContext({
    workspaceId: workspaceRecord?.id,
    workspaceRules,
    databaseInstance,
    schema,
    metricMappings,
    catalog,
    semantic,
    knowledge,
  });

  const sampleLimit = Math.max(1, Math.min(input.sampleLimit || 12, 20));
  const extractedSamples = extractSamples({
    workspaceId: workspaceRecord?.id,
    databaseId: input.databaseId,
    sampleLimit,
    workspaceRules,
  });
  const samples = extractedSamples.length > 0
    ? extractedSamples
    : buildSyntheticSamples({
        catalog,
        semantic,
        sampleLimit,
      });

  const candidateSet = buildPolicyCandidates(input.promptCandidateCount || 2, input.policyCandidateCount || 3);
  const evaluationResults = candidateSet.map((candidate) => ({
    candidate,
    score: samples.reduce((total, sample) => total + estimatePromptScore({
      question: sample.question,
      workspace: evaluationWorkspace,
      candidate,
      sampleId: sample.sampleId,
      schema,
    }).candidate.score, 0) / Math.max(samples.length, 1),
  }));
  const rankedCandidates = evaluationResults
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
    .map((item) => ({
      ...item.candidate,
      notes: [...item.candidate.notes, `平均分：${item.score.toFixed(2)}`],
    }));
  const bestCandidate = rankedCandidates[0] || candidateSet[0];
  const sampleResults = samples.map((sample) => {
    const evaluation = estimatePromptScore({
      question: sample.question,
      workspace: evaluationWorkspace,
      candidate: bestCandidate,
      sampleId: sample.sampleId,
      schema,
    });
    return {
      sampleId: sample.sampleId,
      question: sample.question,
      baseline: evaluation.baseline,
      candidate: evaluation.candidate,
      delta: evaluation.delta,
    } satisfies DBHarnessGepaSampleResult;
  });
  const scoreCard = buildScoreCard(sampleResults);

  const report = {
    mode: 'heuristic',
    summary: {
      sampleCount: sampleResults.length,
      candidateCount: rankedCandidates.length,
      bestCandidate: bestCandidate?.title || '',
      workspaceId: workspaceRecord?.id || '',
      databaseId: input.databaseId,
    },
    rankedCandidates,
    sampleResults,
  };

  return createDBHarnessGepaRun({
    workspaceId: workspaceRecord?.id,
    databaseId: input.databaseId,
    sampleLimit,
    datasetVersion: [workspaceRecord?.updatedAt || '', databaseInstance.updatedAt || ''].filter(Boolean).join('|'),
    candidateSet: rankedCandidates,
    samples: sampleResults,
    scoreCard,
    report,
    status: 'reviewed',
  });
}

export function getGepaRun(id: string) {
  return getDBHarnessGepaRunById(id);
}

export function listGepaRuns(limit?: number) {
  return listDBHarnessGepaRuns(limit);
}

export function applyGepaRun(id: string, input: DBHarnessGepaApplyRequest): { run: DBHarnessGepaRun; workspaceId: string } | null {
  const current = getDBHarnessGepaRunById(id);
  if (!current) {
    return null;
  }

  if (!current.workspaceId) {
    throw new Error('当前 GEPA Run 未指定所属 Workspace，无法应用到运行时配置。请重新创建 Run 并指定 Workspace。');
  }

  const workspace = getDBHarnessWorkspaceById(current.workspaceId);
  if (!workspace) {
    throw new Error('当前 GEPA Run 所属的 Workspace 不存在，无法应用到运行时配置。');
  }

  const appliedCandidates = selectApplicableCandidates(current);
  if (appliedCandidates.length === 0) {
    throw new Error('当前 GEPA Run 没有可应用的候选配置。');
  }

  const runtimeConfigChange = buildAppliedRuntimeConfig(workspace.runtimeConfig || {}, appliedCandidates, current.id);
  const updatedWorkspace = updateDBHarnessWorkspace({
    id: workspace.id,
    runtimeConfig: runtimeConfigChange.after,
  });
  if (!updatedWorkspace) {
    throw new Error('写入 Workspace 运行时配置失败。');
  }

  const run = updateDBHarnessGepaRun(id, {
    status: 'applied',
    approvedAt: current.approvedAt || new Date().toISOString(),
    approvedBy: input.approvedBy?.trim() || current.approvedBy || 'system',
    appliedAt: new Date().toISOString(),
    report: {
      ...current.report,
      applied: true,
      appliedWorkspaceId: workspace.id,
      appliedCandidates: appliedCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        kind: candidate.kind,
      })),
      runtimeConfigBefore: runtimeConfigChange.before,
      runtimeConfigAfter: runtimeConfigChange.after,
      runtimeConfigDiff: runtimeConfigChange.diff,
    },
  });
  return run ? { run, workspaceId: workspace.id } : null;
}

export function removeGepaRun(id: string) {
  return deleteDBHarnessGepaRun(id);
}

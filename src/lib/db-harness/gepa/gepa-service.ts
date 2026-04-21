import { buildAiChatEndpoint } from '@/lib/ai-models';
import { DatabaseInstanceType } from '@/lib/types';
import {
  getAllAIModelProfiles,
  getDatabaseInstanceById,
  getDBHarnessWorkspaceById,
  listDBHarnessKnowledgeMemory,
  listDBHarnessPromptTemplates,
  listDBHarnessQueryMetrics,
} from '@/lib/db';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import { getEffectiveDatabaseMetricMappings, sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import {
  DBHarnessGepaApplyRequest,
  DBHarnessChatMessage,
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
  DBHarnessPromptTemplateRecord,
  DBHarnessQueryMetricRecord,
} from '../core/types';
import { buildKeywordSet } from '../core/utils';
import { deriveCatalogSnapshot, deriveSemanticSnapshot } from '../tools/catalog-tools';
import { executeReadOnlyPlan } from '../tools/guardrail-tools';
import {
  buildFallbackNerPayload,
  buildFallbackPlanningHints,
  buildFallbackQueryPlan,
  buildNerCandidateBundle,
  buildQueryPromptContext,
} from '../tools/planning-tools';
import { validateExecutionResult } from '../tools/validation-tools';
import { buildGepaPatternCandidates, buildGepaPatternSummary } from './pattern-extraction';
import { buildGepaPresetCandidates, DBHarnessGepaPresetCandidate } from './candidate-presets';
import {
  createDBHarnessGepaRun,
  deleteDBHarnessGepaRun,
  getDBHarnessGepaRunById,
  listDBHarnessGepaRuns,
  updateDBHarnessWorkspace,
  updateDBHarnessGepaRun,
} from '@/lib/db';

type GepaPolicyCandidate = DBHarnessGepaPresetCandidate;
const ONLINE_GEPA_MIN_METRICS = 4;
const ONLINE_GEPA_COOLDOWN_MS = 45 * 60 * 1000;

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
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
  const scoreCard = run.scoreCard;
  const promptCandidate = run.candidateSet
    .find((candidate) => candidate.kind === 'prompt' && (candidate.source === 'template' || candidate.source === 'pattern') && (candidate.confidence || 0) >= 0.82)
    || null;
  const policyCandidate = run.candidateSet
    .find((candidate) => candidate.kind === 'policy'
      && scoreCard.balancedScore >= (scoreCard.baselineBalancedScore || 0)
      && scoreCard.sqlSuccessRate >= 0.5
      && scoreCard.emptyRate <= 0.45)
    || null;
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

interface GepaSessionSample {
  sampleId: string;
  question: string;
  priority: number;
  reason: string;
  createdAt: string;
}

interface GepaEvaluationSample {
  sampleId: string;
  question: string;
  source: 'metric' | 'session' | 'synthetic';
  priority?: number;
  reason?: string;
  metric?: DBHarnessQueryMetricRecord;
}

function buildSessionSamplePriority(message: DBHarnessChatMessage | undefined) {
  if (!message || message.role !== 'assistant') {
    return { priority: 0, reason: 'latest-question' };
  }

  const feedback = message.meta?.feedback;
  const confidence = typeof message.meta?.confidence === 'number' ? message.meta.confidence : null;

  if (feedback?.status === 'corrective') {
    return { priority: 5, reason: 'corrective-feedback' };
  }
  if (message.status === 'error') {
    return { priority: 4, reason: 'assistant-error' };
  }
  if (typeof confidence === 'number' && confidence < 0.72) {
    return { priority: 3, reason: 'low-confidence' };
  }
  if (typeof confidence === 'number' && confidence < 0.82) {
    return { priority: 2, reason: 'medium-confidence' };
  }
  return { priority: 1, reason: 'latest-question' };
}

function extractSamples(input: {
  workspaceId?: string;
  databaseId: string;
  sampleLimit: number;
  workspaceRules: string;
}): GepaSessionSample[] {
  const workspace = input.workspaceId ? getDBHarnessWorkspaceById(input.workspaceId) : null;
  const sessions = workspace?.sessions
    .filter((session) => !session.selectedDatabaseId || session.selectedDatabaseId === input.databaseId)
    .sort((left, right) => Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt))
    .slice(0, Math.max(input.sampleLimit * 2, 12)) || [];

  const sessionSamples = sessions.flatMap((session) => {
    const samples: GepaSessionSample[] = [];
    for (let index = 0; index < session.messages.length; index += 1) {
      const current = session.messages[index];
      if (current?.role !== 'assistant') continue;
      const previous = session.messages[index - 1];
      if (previous?.role !== 'user') continue;
      const question = previous.content?.trim();
      if (!question) continue;
      const { priority, reason } = buildSessionSamplePriority(current);
      samples.push({
        sampleId: `${session.id}:${index}`,
        question,
        priority,
        reason,
        createdAt: current.createdAt || session.lastMessageAt,
      });
    }

    if (samples.length > 0) {
      return samples;
    }

    const question = latestUserMessage(session.messages);
    return question
      ? [{
          sampleId: session.id,
          question,
          priority: 1,
          reason: 'latest-question',
          createdAt: session.lastMessageAt,
        }]
      : [];
  });

  const unique = new Map<string, GepaSessionSample>();
  sessionSamples.forEach((sample) => {
    const key = sample.question.trim().toLowerCase();
    const current = unique.get(key);
    if (!current) {
      unique.set(key, sample);
      return;
    }
    if (sample.priority > current.priority) {
      unique.set(key, sample);
      return;
    }
    if (sample.priority === current.priority && Date.parse(sample.createdAt) > Date.parse(current.createdAt)) {
      unique.set(key, sample);
    }
  });

  return Array.from(unique.values())
    .sort((left, right) => right.priority - left.priority || Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, input.sampleLimit);
}

function extractMetricsSamples(input: {
  workspaceId?: string;
  databaseId: string;
  sampleLimit: number;
}): GepaEvaluationSample[] {
  return listDBHarnessQueryMetrics({
    workspaceId: input.workspaceId,
    databaseId: input.databaseId,
    limit: input.sampleLimit,
  }).map((metric) => ({
    sampleId: metric.turnId,
    question: metric.question,
    source: 'metric' as const,
    metric,
  }));
}

function buildTemplateCandidates(templates: DBHarnessPromptTemplateRecord[]): GepaPolicyCandidate[] {
  return templates
    .filter((template) => template.source === 'feedback' && template.confidence >= 0.78)
    .slice(0, 3)
    .map((template, index) => ({
      id: `template-${index + 1}-${template.templateKey}`,
      kind: 'prompt',
      source: 'template',
      title: template.title,
      description: template.description,
      promptPatch: template.promptPatch,
      confidence: clampConfidence(template.confidence),
      notes: [
        `来自高置信度正反馈模板库，置信度 ${template.confidence.toFixed(2)}`,
        template.lastUsedAt ? `最近使用于 ${template.lastUsedAt}` : '尚未应用到运行时',
      ],
      compressionLevel: template.compressionLevel || 'compact',
      nerTopK: template.nerCandidateLimit || 20,
    }));
}

function buildSyntheticSamples(input: {
  catalog: DBHarnessCatalogSnapshot;
  semantic: DBHarnessSemanticSnapshot;
  sampleLimit: number;
}): GepaEvaluationSample[] {
  const samples: GepaEvaluationSample[] = [];
  const focusTables = input.catalog.entities.slice(0, 4);
  const focusSemantic = input.semantic.entities.slice(0, 4);

  focusTables.forEach((entity, index) => {
    if (samples.length >= input.sampleLimit) return;
    const metric = focusSemantic[index]?.metrics[0] || focusSemantic[0]?.metrics[0] || '核心指标';
    const dimension = focusSemantic[index]?.dimensions[0] || '维度';
    samples.push({
      sampleId: `synthetic-${index + 1}`,
      question: `请分析 ${entity.name} 的 ${metric}，并按 ${dimension} 展开。`,
      source: 'synthetic',
    });
  });

  while (samples.length < input.sampleLimit) {
    const fallbackTable = focusTables[samples.length % Math.max(focusTables.length, 1)]?.name || '核心数据表';
    samples.push({
      sampleId: `synthetic-${samples.length + 1}`,
      question: `查询 ${fallbackTable} 最近 7 天的核心指标变化。`,
      source: 'synthetic',
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
  promptTemplates: DBHarnessWorkspaceContext['promptTemplates'];
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
    promptTemplates: input.promptTemplates,
  } satisfies DBHarnessWorkspaceContext;
}

async function estimatePromptScore(input: {
  sample: GepaEvaluationSample;
  workspace: DBHarnessWorkspaceContext;
  candidate: GepaPolicyCandidate;
  schema: Awaited<ReturnType<typeof getDatabaseSchema>>;
}) {
  const engine = input.workspace.databaseInstance.type as DatabaseInstanceType;
  const question = input.sample.question;
  const keywords = buildKeywordSet(question, input.workspace.workspaceRules || '', input.workspace.databaseInstance.name);
  const nerBundle = buildNerCandidateBundle(input.schema, input.workspace.metricMappings, keywords);
  const effectiveTopK = Math.min(input.candidate.nerTopK, nerBundle.candidateCount || nerBundle.totalAvailable);
  const nerPayload = buildFallbackNerPayload(question, input.schema, input.workspace.metricMappings);
  const planningHints = buildFallbackPlanningHints(question, input.workspace);
  const adjustedNerPayload = {
    ...nerPayload,
    matchedMetrics: nerPayload.matchedMetrics.slice(0, effectiveTopK),
  };
  const adjustedPlanningHints = {
    ...planningHints,
    notes: [
      ...planningHints.notes,
      input.candidate.description,
      input.candidate.promptPatch || '',
    ].filter(Boolean).slice(0, 6),
  };

  const sampleSession: DBHarnessSessionContext = {
    turnId: input.sample.sampleId,
    startedAt: new Date().toISOString(),
    messages: [{ role: 'user', content: question }],
    latestUserMessage: question,
    currentSql: '',
    currentResult: null,
    recentQuestions: [question],
  };

  const baselinePrompt = buildQueryPromptContext(sampleSession, input.workspace, planningHints, nerPayload, 'standard');
  const candidatePrompt = buildQueryPromptContext(sampleSession, input.workspace, adjustedPlanningHints, adjustedNerPayload, input.candidate.compressionLevel);

  async function evaluateVariant(
    variantNerPayload: typeof nerPayload,
    variantPlanningHints: typeof planningHints,
    promptText: string,
    detailPrefix: string
  ) {
    const tokenCost = Math.round(promptText.length / 4);
    const startedAt = Date.now();
    try {
      const queryResult = buildFallbackQueryPlan(question, engine, input.workspace, variantNerPayload, variantPlanningHints);
      const execution = await executeReadOnlyPlan(queryResult.plan, input.workspace);
      const validation = validateExecutionResult(question, queryResult.plan, execution);
      const latencyMs = Math.max(1, Date.now() - startedAt);
      const status = execution.rows.length > 0 ? 'success' as const : 'empty' as const;
      let score = (status === 'success' ? 100 : 44)
        + Math.min(14, execution.rows.length * 1.4)
        + validation.score * 12
        - latencyMs / 220
        - tokenCost / 260;
      if (input.sample.metric) {
        if (input.sample.metric.outcome !== 'success' && status === 'success') score += 10;
        if (input.sample.metric.outcome === 'success' && status === 'success') score += 4;
        if (input.sample.metric.outcome === 'success' && status !== 'success') score -= 8;
        if (input.sample.metric.confidence < 0.72 && status === 'success') score += 4;
      }
      return {
        status,
        latencyMs,
        tokenCost,
        score: Math.max(0, Number(score.toFixed(2))),
        detail: `${detailPrefix} ${validation.summary}`,
      };
    } catch (error) {
      const latencyMs = Math.max(1, Date.now() - startedAt);
      const detail = error instanceof Error ? error.message : String(error);
      const score = Math.max(0, 12 - latencyMs / 260 - tokenCost / 300);
      return {
        status: 'error' as const,
        latencyMs,
        tokenCost,
        score: Number(score.toFixed(2)),
        detail,
      };
    }
  }

  const baseline = await evaluateVariant(
    nerPayload,
    planningHints,
    baselinePrompt,
    '基线策略已完成真实执行回放。'
  );
  const candidate = await evaluateVariant(
    adjustedNerPayload,
    adjustedPlanningHints,
    candidatePrompt,
    `候选 ${input.candidate.title} 已完成真实执行回放。`
  );

  return {
    baseline,
    candidate,
    delta: {
      score: Number((candidate.score - baseline.score).toFixed(2)),
      latencyMs: candidate.latencyMs - baseline.latencyMs,
      tokenCost: candidate.tokenCost - baseline.tokenCost,
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
  const errorCount = results.filter((item) => item.candidate.status === 'error').length;

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
      '当前版本优先基于真实执行回放评估候选，异常样本会自动记为 error。',
      errorCount > 0 ? `本轮有 ${errorCount} 个样本在候选回放中执行失败。` : '',
    ],
  };
}

function shouldTriggerOnlineGepa(metrics: DBHarnessQueryMetricRecord[]) {
  if (metrics.length < ONLINE_GEPA_MIN_METRICS) {
    return false;
  }
  const failureCount = metrics.filter((metric) => metric.outcome === 'empty' || metric.outcome === 'error').length;
  const reviewCount = metrics.filter((metric) =>
    metric.labels.includes('validation-review') || metric.labels.includes('validation-fail')
  ).length;
  const lowConfidenceCount = metrics.filter((metric) => metric.confidence < 0.72).length;
  const averageConfidence = metrics.reduce((sum, metric) => sum + metric.confidence, 0) / Math.max(metrics.length, 1);
  return failureCount >= 2 || reviewCount >= 2 || lowConfidenceCount >= 2 || averageConfidence < 0.7;
}

function findRecentOnlineTriggeredRun(workspaceId: string, databaseId: string) {
  return listDBHarnessGepaRuns(24)
    .filter((run) => run.workspaceId === workspaceId && run.databaseId === databaseId)
    .find((run) => {
      const trigger = run.report?.['trigger'];
      if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
      const kind = typeof (trigger as Record<string, unknown>).kind === 'string'
        ? (trigger as Record<string, unknown>).kind
        : '';
      return kind === 'online-regression';
    }) || null;
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
  const catalog = deriveCatalogSnapshot(schema, metricMappings, databaseInstance.semanticModel);
  const semantic = deriveSemanticSnapshot(schema, metricMappings, databaseInstance.semanticModel);
  if (databaseInstance.type !== 'mysql' && databaseInstance.type !== 'pgsql' && databaseInstance.type !== 'mongo') {
    throw new Error('GEPA 离线评估暂时仅支持 MySQL、PostgreSQL 和 MongoDB 数据源。');
  }
  const sampleLimit = Math.max(1, Math.min(input.sampleLimit || 12, 20));
  const workspaceRules = workspaceRecord.rules || '';
  const knowledge = listDBHarnessKnowledgeMemory({
    workspaceId: workspaceRecord?.id,
    databaseId: input.databaseId,
    limit: 24,
  });
  const promptTemplates = listDBHarnessPromptTemplates({
    workspaceId: workspaceRecord?.id,
    databaseId: input.databaseId,
    limit: 12,
  });
  const recentMetrics = listDBHarnessQueryMetrics({
    workspaceId: workspaceRecord?.id,
    databaseId: input.databaseId,
    limit: Math.max(sampleLimit * 2, 12),
  });
  const evaluationWorkspace = buildOfflineWorkspaceContext({
    workspaceId: workspaceRecord?.id,
    workspaceRules,
    databaseInstance,
    schema,
    metricMappings,
    catalog,
    semantic,
    knowledge,
    promptTemplates,
  });

  const metricSamples = extractMetricsSamples({
    workspaceId: workspaceRecord?.id,
    databaseId: input.databaseId,
    sampleLimit,
  });
  const extractedSamples = extractSamples({
    workspaceId: workspaceRecord?.id,
    databaseId: input.databaseId,
    sampleLimit,
    workspaceRules,
  });
  const mergedSamples = [
    ...metricSamples,
    ...extractedSamples.map<GepaEvaluationSample>((item) => ({
      sampleId: item.sampleId,
      question: item.question,
      source: 'session' as const,
      priority: item.priority,
      reason: item.reason,
    })),
  ].reduce<GepaEvaluationSample[]>((list, sample) => {
    if (!sample.question.trim()) return list;
    const existingIndex = list.findIndex((item) => item.question.trim().toLowerCase() === sample.question.trim().toLowerCase());
    if (existingIndex < 0) {
      list.push(sample);
      return list;
    }
    const current = list[existingIndex];
    const currentPriority = current.metric ? 6 : current.priority || 0;
    const nextPriority = sample.metric ? 6 : sample.priority || 0;
    if (nextPriority >= currentPriority) {
      list[existingIndex] = sample;
    }
    return list;
  }, []);
  const samples = mergedSamples.length > 0
    ? mergedSamples.slice(0, sampleLimit)
    : buildSyntheticSamples({
        catalog,
        semantic,
        sampleLimit,
      });
  const regressionSignal = recentMetrics.some((metric) => metric.outcome === 'empty' || metric.outcome === 'error')
    || (recentMetrics.length > 0 && recentMetrics.reduce((total, metric) => total + metric.confidence, 0) / recentMetrics.length < 0.7);
  const templateCandidates = regressionSignal ? buildTemplateCandidates(promptTemplates) : [];
  const patternCandidates = buildGepaPatternCandidates({
    metrics: recentMetrics,
    templates: promptTemplates,
    limit: 3,
  }).map((candidate) => ({
      id: candidate.id,
      kind: 'prompt' as const,
      source: 'pattern' as const,
      title: candidate.title,
      description: candidate.description,
      promptPatch: candidate.promptPatch,
      confidence: candidate.confidence,
      notes: [
        `模式抽取信号：${candidate.signal}`,
        ...candidate.labels.map((label) => `标签：${label}`),
    ].slice(0, 6),
    compressionLevel: candidate.compressionLevel,
    nerTopK: candidate.nerTopK,
  }));
  const candidateSet = [
    ...buildGepaPresetCandidates({
      promptCandidateCount: input.promptCandidateCount || 2,
      policyCandidateCount: input.policyCandidateCount || 3,
      selectedPromptCandidateIds: input.selectedPromptCandidateIds,
      selectedPolicyCandidateIds: input.selectedPolicyCandidateIds,
    }),
    ...templateCandidates,
    ...patternCandidates,
  ].slice(0, 6);
  const evaluationResults: Array<{ candidate: GepaPolicyCandidate; score: number }> = [];
  for (const candidate of candidateSet) {
    let total = 0;
    for (const sample of samples) {
      const evaluation = await estimatePromptScore({
        sample,
        workspace: evaluationWorkspace,
        candidate,
        schema,
      });
      total += evaluation.candidate.score;
    }
    evaluationResults.push({
      candidate,
      score: total / Math.max(samples.length, 1),
    });
  }
  const rankedCandidates = evaluationResults
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
    .map((item) => ({
      ...item.candidate,
      notes: [...item.candidate.notes, `平均分：${item.score.toFixed(2)}`],
    }));
  const bestCandidate = rankedCandidates[0] || candidateSet[0];
  const sampleResults: DBHarnessGepaSampleResult[] = [];
  for (const sample of samples) {
    const evaluation = await estimatePromptScore({
      sample,
      workspace: evaluationWorkspace,
      candidate: bestCandidate,
      schema,
    });
    sampleResults.push({
      sampleId: sample.sampleId,
      question: sample.question,
      baseline: evaluation.baseline,
      candidate: evaluation.candidate,
      delta: evaluation.delta,
    } satisfies DBHarnessGepaSampleResult);
  }
  const scoreCard = buildScoreCard(sampleResults);

  const report = {
    mode: 'execution-backed',
    patternSummary: buildGepaPatternSummary(recentMetrics),
    candidateSources: {
      policy: candidateSet.filter((candidate) => candidate.source === 'policy').length,
      template: candidateSet.filter((candidate) => candidate.source === 'template').length,
      pattern: candidateSet.filter((candidate) => candidate.source === 'pattern').length,
    },
    summary: {
      sampleCount: sampleResults.length,
      candidateCount: rankedCandidates.length,
      bestCandidate: bestCandidate?.title || '',
      workspaceId: workspaceRecord?.id || '',
      databaseId: input.databaseId,
      regressionSignal,
      templateCount: promptTemplates.length,
      metricSampleCount: metricSamples.length,
      sessionSampleCount: extractedSamples.length,
      adjustedSessionSampleCount: extractedSamples.filter((sample) => sample.priority >= 3).length,
    },
    rankedCandidates,
    sampleResults,
    realMetrics: recentMetrics.slice(0, sampleLimit).map((metric) => ({
      turnId: metric.turnId,
      question: metric.question,
      outcome: metric.outcome,
      confidence: metric.confidence,
      fromCache: metric.fromCache,
      labels: metric.labels,
    })),
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

export async function maybeTriggerOnlineGepaEvaluation(input: {
  workspaceId?: string;
  databaseId: string;
  turnId?: string;
}) {
  const workspaceId = input.workspaceId?.trim() || '';
  if (!workspaceId || !input.databaseId.trim()) {
    return null;
  }

  const recentMetrics = listDBHarnessQueryMetrics({
    workspaceId,
    databaseId: input.databaseId,
    limit: 8,
  });
  if (!shouldTriggerOnlineGepa(recentMetrics)) {
    return null;
  }

  const recentRun = findRecentOnlineTriggeredRun(workspaceId, input.databaseId);
  if (recentRun) {
    const recentRunTime = Date.parse(recentRun.createdAt || recentRun.updatedAt || '');
    if (Number.isFinite(recentRunTime) && Date.now() - recentRunTime < ONLINE_GEPA_COOLDOWN_MS) {
      return recentRun;
    }
  }

  const sampleLimit = Math.max(3, Math.min(6, recentMetrics.length));
  const run = await runGepaCreate({
    workspaceId,
    databaseId: input.databaseId,
    sampleLimit,
    promptCandidateCount: 2,
    policyCandidateCount: 3,
  });

  return updateDBHarnessGepaRun(run.id, {
    report: {
      ...run.report,
      trigger: {
        kind: 'online-regression',
        metricCount: recentMetrics.length,
        turnId: input.turnId || recentMetrics[0]?.turnId || '',
        triggeredAt: new Date().toISOString(),
      },
    },
  }) || run;
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

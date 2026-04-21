import { nanoid } from 'nanoid';
import {
  getDBHarnessWorkspaceById,
  listDBHarnessKnowledgeMemory,
  listDBHarnessPromptTemplates,
  listDBHarnessQueryMetrics,
  listDBHarnessWorkspaceUpgrades,
  upsertDBHarnessKnowledgeMemory,
  upsertDBHarnessPromptTemplate,
  upsertDBHarnessWorkspaceUpgrade,
  updateDBHarnessWorkspace,
  getDBHarnessWorkspaceUpgradeById,
} from '@/lib/db';
import type {
  DBHarnessPromptTemplateRecord,
  DBHarnessUpgradeArtifactType,
  DBHarnessUpgradeCandidate,
} from '../core/types';
import { evaluateWorkspaceUpgradeMetrics } from '../gepa/upgrade-evaluators';

interface ExtractWorkspaceUpgradesInput {
  workspaceId: string;
  limit?: number;
}

interface EvaluateWorkspaceUpgradeInput {
  workspaceId: string;
  upgradeId: string;
}

interface ApplyWorkspaceUpgradeInput {
  workspaceId: string;
  upgradeId: string;
  approvedBy?: string;
}

interface RejectWorkspaceUpgradeInput {
  workspaceId: string;
  upgradeId: string;
  reason?: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
}

function buildEvaluationFromMetrics(workspaceId: string, databaseId: string) {
  const metrics = listDBHarnessQueryMetrics({ workspaceId, databaseId, limit: 120 });
  return evaluateWorkspaceUpgradeMetrics(metrics);
}

function canUseTemplate(template: DBHarnessPromptTemplateRecord): boolean {
  return template.confidence >= 0.72 && template.promptPatch.trim().length > 0;
}

function buildPendingCandidate(input: {
  workspaceId: string;
  sourceTurnId: string;
  target: DBHarnessUpgradeCandidate['target'];
  artifactType: DBHarnessUpgradeArtifactType;
  title: string;
  description: string;
  confidence: number;
  summary: string;
  promptPatch?: string;
  payload?: Record<string, unknown>;
}): Omit<DBHarnessUpgradeCandidate, 'createdAt' | 'updatedAt'> {
  return {
    id: nanoid(),
    workspaceId: input.workspaceId,
    sourceTurnId: input.sourceTurnId,
    target: input.target,
    artifactType: input.artifactType,
    status: 'pending_review',
    confidence: clamp01(input.confidence),
    title: input.title,
    description: input.description,
    artifact: {
      type: input.artifactType,
      summary: input.summary,
      promptPatch: input.promptPatch,
      payload: input.payload,
    },
  };
}

export function listWorkspaceUpgrades(workspaceId: string, status?: DBHarnessUpgradeCandidate['status']) {
  return listDBHarnessWorkspaceUpgrades({
    workspaceId,
    status,
    limit: 120,
  });
}

export function extractWorkspaceUpgrades(input: ExtractWorkspaceUpgradesInput): DBHarnessUpgradeCandidate[] {
  const workspace = getDBHarnessWorkspaceById(input.workspaceId);
  if (!workspace) {
    throw new Error('Workspace 不存在。');
  }
  if (!workspace.databaseId) {
    throw new Error('Workspace 尚未绑定数据源，无法抽取升级候选。');
  }

  const existing = listDBHarnessWorkspaceUpgrades({
    workspaceId: workspace.id,
    limit: 200,
  });
  const existingTitleSet = new Set(existing.map((item) => `${item.artifactType}:${item.title}`));

  const metrics = listDBHarnessQueryMetrics({
    workspaceId: workspace.id,
    databaseId: workspace.databaseId,
    limit: 80,
  });
  const knowledge = listDBHarnessKnowledgeMemory({
    workspaceId: workspace.id,
    databaseId: workspace.databaseId,
    limit: 80,
  });
  const templates = listDBHarnessPromptTemplates({
    workspaceId: workspace.id,
    databaseId: workspace.databaseId,
    limit: 24,
  }).filter(canUseTemplate);

  const candidates: Omit<DBHarnessUpgradeCandidate, 'createdAt' | 'updatedAt'>[] = [];
  const lowConfidenceMetric = metrics.find((item) => item.confidence < 0.72 || item.outcome !== 'success');
  if (lowConfidenceMetric) {
    candidates.push(buildPendingCandidate({
      workspaceId: workspace.id,
      sourceTurnId: lowConfidenceMetric.turnId,
      target: 'query',
      artifactType: 'prompt_patch',
      title: 'Query Agent 低置信度补丁',
      description: '根据低置信度样本抽取 Query 阶段 Prompt 补丁，优先提升空结果与低验证分场景。',
      confidence: 0.74,
      summary: '优先选择高命中语义字段，并在空结果场景回退到更稳健的时间范围。',
      promptPatch: '优先复用历史高命中字段；当 validationScore 低于 0.6 时，收敛查询范围并补充过滤解释。',
    }));
  }

  const correctionEntry = knowledge.find((item) => item.feedbackType === 'corrective' && item.correctionRule);
  if (correctionEntry?.correctionRule) {
    candidates.push(buildPendingCandidate({
      workspaceId: workspace.id,
      sourceTurnId: correctionEntry.payload?.messageId && typeof correctionEntry.payload.messageId === 'string'
        ? correctionEntry.payload.messageId
        : `knowledge:${correctionEntry.key}`,
      target: 'schema',
      artifactType: 'correction_rule',
      title: 'Schema 纠正规则升级',
      description: '将高价值纠错反馈沉淀为结构化规则，提升术语映射稳定性。',
      confidence: 0.78,
      summary: correctionEntry.summary,
      payload: {
        correctionRule: correctionEntry.correctionRule,
      },
    }));
  }

  const template = templates[0];
  if (template) {
    candidates.push(buildPendingCandidate({
      workspaceId: workspace.id,
      sourceTurnId: `template:${template.id}`,
      target: 'analysis',
      artifactType: 'analysis_template',
      title: 'Analysis 高质量模板升级',
      description: '复用高质量历史模板，稳定答案解释与追问风格。',
      confidence: clamp01(template.confidence),
      summary: template.description || template.title,
      promptPatch: template.promptPatch,
      payload: {
        templateId: template.id,
      },
    }));
  }

  const limit = Math.max(1, Math.min(input.limit ?? 8, 24));
  const next = candidates
    .filter((item) => !existingTitleSet.has(`${item.artifactType}:${item.title}`))
    .slice(0, limit)
    .map((item) => upsertDBHarnessWorkspaceUpgrade(item));
  return next;
}

export function evaluateWorkspaceUpgrade(input: EvaluateWorkspaceUpgradeInput): DBHarnessUpgradeCandidate {
  const workspace = getDBHarnessWorkspaceById(input.workspaceId);
  if (!workspace || !workspace.databaseId) {
    throw new Error('Workspace 不存在或未绑定数据源。');
  }
  const candidate = getDBHarnessWorkspaceUpgradeById(input.upgradeId);
  if (!candidate || candidate.workspaceId !== workspace.id) {
    throw new Error('升级候选不存在。');
  }
  const evaluation = buildEvaluationFromMetrics(workspace.id, workspace.databaseId);
  return upsertDBHarnessWorkspaceUpgrade({
    ...candidate,
    evaluation,
    status: candidate.status === 'draft' ? 'pending_review' : candidate.status,
    confidence: clamp01((candidate.confidence * 0.6) + (evaluation.score * 0.4)),
  });
}

function appendPromptStrategy(current: string | undefined, patch: string): string {
  const safePatch = patch.trim();
  if (!safePatch) return current || '';
  const next = (current || '').trim();
  if (!next) return safePatch;
  if (next.includes(safePatch)) return next;
  return `${next}\n\n${safePatch}`;
}

export function applyWorkspaceUpgrade(input: ApplyWorkspaceUpgradeInput): DBHarnessUpgradeCandidate {
  const workspace = getDBHarnessWorkspaceById(input.workspaceId);
  if (!workspace || !workspace.databaseId) {
    throw new Error('Workspace 不存在或未绑定数据源。');
  }
  const candidate = getDBHarnessWorkspaceUpgradeById(input.upgradeId);
  if (!candidate || candidate.workspaceId !== workspace.id) {
    throw new Error('升级候选不存在。');
  }

  const evaluated = candidate.evaluation ? candidate : evaluateWorkspaceUpgrade({
    workspaceId: workspace.id,
    upgradeId: candidate.id,
  });

  const patch = evaluated.artifact.promptPatch || '';
  const currentRuntime = workspace.runtimeConfig || {};
  const nextRuntime = {
    ...currentRuntime,
    source: 'manual' as const,
    promptStrategy: appendPromptStrategy(currentRuntime.promptStrategy, patch),
    updatedAt: new Date().toISOString(),
  };

  if (evaluated.artifactType === 'query_template' || evaluated.artifactType === 'analysis_template') {
    upsertDBHarnessPromptTemplate({
      templateKey: `upgrade:${evaluated.workspaceId}:${evaluated.id}`,
      workspaceId: workspace.id,
      databaseId: workspace.databaseId,
      source: 'feedback',
      title: evaluated.title,
      description: evaluated.description,
      promptPatch: patch || evaluated.artifact.summary,
      confidence: evaluated.confidence,
      labels: ['workspace-upgrade', evaluated.target, evaluated.artifactType],
    });
  }

  if (evaluated.artifactType === 'correction_rule' && evaluated.artifact.payload?.correctionRule) {
    upsertDBHarnessKnowledgeMemory({
      key: `upgrade:${evaluated.id}`,
      workspaceId: workspace.id,
      databaseId: workspace.databaseId,
      source: 'feedback',
      feedbackType: 'corrective',
      summary: evaluated.artifact.summary || evaluated.description,
      tags: ['workspace-upgrade', 'correction-rule'],
      payload: {
        correctionRule: evaluated.artifact.payload.correctionRule,
        generatedBy: 'workspace-upgrade-service',
      },
    });
  }

  updateDBHarnessWorkspace({
    id: workspace.id,
    runtimeConfig: nextRuntime,
  });

  return upsertDBHarnessWorkspaceUpgrade({
    ...evaluated,
    status: 'applied',
    appliedAt: new Date().toISOString(),
  });
}

export function rejectWorkspaceUpgrade(input: RejectWorkspaceUpgradeInput): DBHarnessUpgradeCandidate {
  const candidate = getDBHarnessWorkspaceUpgradeById(input.upgradeId);
  if (!candidate || candidate.workspaceId !== input.workspaceId) {
    throw new Error('升级候选不存在。');
  }
  return upsertDBHarnessWorkspaceUpgrade({
    ...candidate,
    status: 'rejected',
    rejectedReason: input.reason?.trim() || 'manual-reject',
  });
}

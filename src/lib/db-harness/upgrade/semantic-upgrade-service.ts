import { nanoid } from 'nanoid';
import {
  getDatabaseInstanceById,
  getDBHarnessWorkspaceById,
  getDBHarnessSemanticUpgradeById,
  listDBHarnessKnowledgeMemory,
  listDBHarnessQueryMetrics,
  listDBHarnessSemanticUpgradeRollouts,
  listDBHarnessSemanticUpgrades,
  listDBHarnessWorkspacesByDatabaseId,
  updateDatabaseInstanceSemanticModel,
  upsertDBHarnessSemanticUpgrade,
  upsertDBHarnessSemanticUpgradeRollout,
} from '@/lib/db';
import { sanitizeDatabaseSemanticModel } from '@/lib/database-instances';
import { deriveSemanticSnapshot } from '../tools/catalog-tools';
import { getDatabaseSchema } from '@/lib/database-instances-server';
import type {
  DBHarnessSemanticUpgradeCandidate,
  DBHarnessSemanticUpgradeEvidence,
  DBHarnessSemanticUpgradeDiff,
  DBHarnessSemanticUpgradeGovernance,
  DBHarnessSemanticUpgradeRollout,
} from '../core/types';
import type { DatabaseSemanticModel } from '@/lib/types';
import { evaluateSemanticUpgradeMetrics } from '../gepa/upgrade-evaluators';

interface ExtractSemanticUpgradesInput {
  databaseId: string;
  sourceWorkspaceId: string;
  limit?: number;
}

interface EvaluateSemanticUpgradeInput {
  databaseId: string;
  upgradeId: string;
}

interface StartSemanticRolloutInput {
  databaseId: string;
  upgradeId: string;
  workspaceIds?: string[];
}

interface FinalizeSemanticUpgradeInput {
  databaseId: string;
  upgradeId: string;
}

interface RejectSemanticUpgradeInput {
  databaseId: string;
  upgradeId: string;
  reason?: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
}

function evaluateForDatabase(databaseId: string) {
  const workspaces = listDBHarnessWorkspacesByDatabaseId(databaseId);
  const allMetrics = workspaces.flatMap((workspace) => listDBHarnessQueryMetrics({
    workspaceId: workspace.id,
    databaseId,
    limit: 120,
  }));
  return evaluateSemanticUpgradeMetrics({
    metrics: allMetrics,
    workspaceCount: workspaces.length,
  });
}

interface SemanticAliasCandidateProposal {
  diff: DBHarnessSemanticUpgradeDiff;
  confidence: number;
  title: string;
  description: string;
  evidence: DBHarnessSemanticUpgradeEvidence[];
}

function normalizeAlias(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function buildAliasCandidateProposalsFromKnowledge(databaseId: string): SemanticAliasCandidateProposal[] {
  const knowledge = listDBHarnessKnowledgeMemory({
    databaseId,
    limit: 240,
  });
  const aggregate = new Map<string, {
    diff: DBHarnessSemanticUpgradeDiff;
    workspaceIds: Set<string>;
    hitCount: number;
    sampleNotes: string[];
  }>();

  knowledge.forEach((entry) => {
    const rule = entry.correctionRule;
    if (!rule?.wrongMapping?.table || !rule?.wrongMapping?.column) return;
    const alias = normalizeAlias(rule.correctMapping?.label || rule.note || '');
    if (!alias) return;
    const table = rule.wrongMapping.table.trim();
    const column = rule.wrongMapping.column.trim();
    if (!table || !column) return;
    const key = `${table}.${column}:${alias.toLowerCase()}`;
    const current = aggregate.get(key);
    if (current) {
      current.hitCount += 1;
      if (entry.workspaceId?.trim()) {
        current.workspaceIds.add(entry.workspaceId.trim());
      }
      const note = normalizeAlias(rule.note || '');
      if (note && !current.sampleNotes.includes(note) && current.sampleNotes.length < 3) {
        current.sampleNotes.push(note);
      }
      return;
    }
    const initialNote = normalizeAlias(rule.note || '');
    aggregate.set(key, {
      diff: {
        changeType: 'alias',
        fieldRef: {
          table,
          column,
        },
        before: rule.wrongMapping.label || '',
        after: alias,
      },
      workspaceIds: new Set(entry.workspaceId?.trim() ? [entry.workspaceId.trim()] : []),
      hitCount: 1,
      sampleNotes: initialNote ? [initialNote] : [],
    });
  });
  return Array.from(aggregate.values())
    .sort((a, b) => {
      const workspaceDelta = b.workspaceIds.size - a.workspaceIds.size;
      if (workspaceDelta !== 0) return workspaceDelta;
      return b.hitCount - a.hitCount;
    })
    .map((item) => {
      const workspaceCount = item.workspaceIds.size;
      const hitCount = item.hitCount;
      const kind: DBHarnessSemanticUpgradeEvidence['kind'] = workspaceCount >= 2
        ? 'cross_workspace_synonym'
        : 'corrective_feedback';
      const confidence = clamp01(
        0.66
        + Math.min(workspaceCount, 3) * 0.08
        + Math.min(hitCount, 5) * 0.035
      );
      const target = `${item.diff.fieldRef.table}.${item.diff.fieldRef.column}`;
      const alias = String(item.diff.after);
      return {
        diff: item.diff,
        confidence,
        title: `语义别名优化 ${target} => ${alias}`,
        description: `命中 ${hitCount} 条纠错样本，覆盖 ${workspaceCount || 1} 个 workspace，建议先灰度后正式写入。`,
        evidence: [{
          kind,
          workspaceCount: workspaceCount || 1,
          hitCount,
          sampleNotes: item.sampleNotes.slice(0, 3),
        }],
      };
    });
}

function applyDiffToSemanticModel(model: DatabaseSemanticModel, diff: DBHarnessSemanticUpgradeDiff): DatabaseSemanticModel {
  const next: DatabaseSemanticModel = JSON.parse(JSON.stringify(model));
  next.entities = (next.entities || []).map((entity) => {
    if (entity.table !== diff.fieldRef.table) return entity;
    const fields = (entity.fields || []).map((field) => {
      if (field.column !== diff.fieldRef.column) return field;
      if (diff.changeType === 'alias' && typeof diff.after === 'string' && diff.after.trim()) {
        const aliases = new Set((field.aliases || []).map((item) => item.trim()).filter(Boolean));
        aliases.add(diff.after.trim());
        return {
          ...field,
          aliases: Array.from(aliases).slice(0, 16),
          derivedFrom: 'manual' as const,
        };
      }
      if (diff.changeType === 'description' && typeof diff.after === 'string') {
        return {
          ...field,
          description: diff.after.trim(),
          derivedFrom: 'manual' as const,
        };
      }
      if (diff.changeType === 'ner_flag' && typeof diff.after === 'boolean') {
        return {
          ...field,
          enableForNer: diff.after,
          derivedFrom: 'manual' as const,
        };
      }
      return field;
    });
    return {
      ...entity,
      fields,
    };
  });
  return next;
}

function ensureWorkspaceOnDatabase(sourceWorkspaceId: string, databaseId: string): void {
  const workspace = getDBHarnessWorkspaceById(sourceWorkspaceId);
  if (!workspace || workspace.databaseId !== databaseId) {
    throw new Error('sourceWorkspaceId 与 databaseId 不匹配。');
  }
}

export function listSemanticUpgrades(databaseId: string, status?: DBHarnessSemanticUpgradeCandidate['status']) {
  return listDBHarnessSemanticUpgrades({
    databaseId,
    status,
    limit: 120,
  });
}

function buildGovernanceForUpgrades(input: {
  databaseId: string;
  upgrades: DBHarnessSemanticUpgradeCandidate[];
}): DBHarnessSemanticUpgradeGovernance[] {
  if (input.upgrades.length === 0) return [];
  const workspacePool = listDBHarnessWorkspacesByDatabaseId(input.databaseId);
  const rollouts = listDBHarnessSemanticUpgradeRollouts({
    databaseId: input.databaseId,
    limit: 400,
  });
  const rolloutsByUpgrade = new Map<string, DBHarnessSemanticUpgradeRollout[]>();
  rollouts.forEach((item) => {
    const list = rolloutsByUpgrade.get(item.upgradeId);
    if (list) {
      list.push(item);
      return;
    }
    rolloutsByUpgrade.set(item.upgradeId, [item]);
  });

  return input.upgrades.map((upgrade) => {
    const relatedRollouts = (rolloutsByUpgrade.get(upgrade.id) || [])
      .slice()
      .sort((a, b) => Date.parse(b.startedAt || '') - Date.parse(a.startedAt || ''));
    const rolloutWorkspaceIds = Array.from(new Set(relatedRollouts.map((item) => item.workspaceId).filter(Boolean)));
    const impactedEntities = Array.from(new Set(upgrade.diffs.map((item) => item.fieldRef.table)));
    const impactedFieldRefs = Array.from(new Set(upgrade.diffs.map((item) => `${item.fieldRef.table}.${item.fieldRef.column}`)));
    const activeRolloutWorkspaceCount = new Set(
      relatedRollouts.filter((item) => item.status === 'active').map((item) => item.workspaceId)
    ).size;
    const completedRolloutWorkspaceCount = new Set(
      relatedRollouts.filter((item) => item.status === 'completed').map((item) => item.workspaceId)
    ).size;
    const stoppedRolloutWorkspaceCount = new Set(
      relatedRollouts.filter((item) => item.status === 'stopped').map((item) => item.workspaceId)
    ).size;
    const impactedWorkspaceIds = upgrade.status === 'finalized'
      ? workspacePool.map((item) => item.id)
      : rolloutWorkspaceIds;

    return {
      upgradeId: upgrade.id,
      impact: {
        databaseWorkspaceCount: workspacePool.length,
        impactedWorkspaceIds,
        rolloutWorkspaceIds,
        impactedEntities,
        impactedFieldRefs,
        activeRolloutWorkspaceCount,
        completedRolloutWorkspaceCount,
        stoppedRolloutWorkspaceCount,
      },
      rolloutTimeline: relatedRollouts.slice(0, 6).map((item) => ({
        workspaceId: item.workspaceId,
        status: item.status,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
      })),
    };
  });
}

export function listSemanticUpgradeGovernance(databaseId: string, status?: DBHarnessSemanticUpgradeCandidate['status']) {
  const upgrades = listSemanticUpgrades(databaseId, status);
  return buildGovernanceForUpgrades({
    databaseId,
    upgrades,
  });
}

export function extractSemanticUpgrades(input: ExtractSemanticUpgradesInput): DBHarnessSemanticUpgradeCandidate[] {
  ensureWorkspaceOnDatabase(input.sourceWorkspaceId, input.databaseId);
  const existing = listDBHarnessSemanticUpgrades({
    databaseId: input.databaseId,
    limit: 200,
  });
  const existingTitleSet = new Set(existing.map((item) => item.title));
  const proposals = buildAliasCandidateProposalsFromKnowledge(input.databaseId);
  const limit = Math.max(1, Math.min(input.limit ?? 8, 24));

  const next: DBHarnessSemanticUpgradeCandidate[] = [];
  proposals.slice(0, limit).forEach((proposal) => {
    const title = proposal.title;
    if (existingTitleSet.has(title)) return;
    const candidate = upsertDBHarnessSemanticUpgrade({
      id: nanoid(),
      databaseId: input.databaseId,
      sourceWorkspaceId: input.sourceWorkspaceId,
      status: 'pending_review',
      confidence: proposal.confidence,
      title,
      description: proposal.description,
      diffs: [proposal.diff],
      evidence: proposal.evidence,
    });
    next.push(candidate);
  });
  return next;
}

export function evaluateSemanticUpgrade(input: EvaluateSemanticUpgradeInput): DBHarnessSemanticUpgradeCandidate {
  const candidate = getDBHarnessSemanticUpgradeById(input.upgradeId);
  if (!candidate || candidate.databaseId !== input.databaseId) {
    throw new Error('语义升级候选不存在。');
  }
  const evaluation = evaluateForDatabase(input.databaseId);
  return upsertDBHarnessSemanticUpgrade({
    ...candidate,
    evaluation,
    status: candidate.status === 'draft' ? 'pending_review' : candidate.status,
    confidence: clamp01((candidate.confidence * 0.6) + (evaluation.score * 0.4)),
  });
}

export function startSemanticRollout(input: StartSemanticRolloutInput): {
  upgrade: DBHarnessSemanticUpgradeCandidate;
  rollouts: DBHarnessSemanticUpgradeRollout[];
} {
  const candidate = getDBHarnessSemanticUpgradeById(input.upgradeId);
  if (!candidate || candidate.databaseId !== input.databaseId) {
    throw new Error('语义升级候选不存在。');
  }
  const evaluated = candidate.evaluation ? candidate : evaluateSemanticUpgrade({
    databaseId: input.databaseId,
    upgradeId: input.upgradeId,
  });

  const workspacePool = listDBHarnessWorkspacesByDatabaseId(input.databaseId).map((item) => item.id);
  const selectedWorkspaces = (input.workspaceIds || [])
    .map((item) => item.trim())
    .filter((item) => workspacePool.includes(item));
  const rolloutWorkspaces = selectedWorkspaces.length > 0
    ? selectedWorkspaces
    : workspacePool.slice(0, 3);

  if (rolloutWorkspaces.length === 0) {
    throw new Error('当前数据源没有可用于灰度的 workspace。');
  }

  const now = new Date().toISOString();
  const rollouts = rolloutWorkspaces.map((workspaceId) => upsertDBHarnessSemanticUpgradeRollout({
    id: nanoid(),
    upgradeId: evaluated.id,
    databaseId: input.databaseId,
    workspaceId,
    status: 'active',
    startedAt: now,
  }));

  const next = upsertDBHarnessSemanticUpgrade({
    ...evaluated,
    status: 'rollout',
  });
  return { upgrade: next, rollouts };
}

export async function finalizeSemanticUpgrade(input: FinalizeSemanticUpgradeInput): Promise<{
  upgrade: DBHarnessSemanticUpgradeCandidate;
  databaseUpdated: boolean;
}> {
  const candidate = getDBHarnessSemanticUpgradeById(input.upgradeId);
  if (!candidate || candidate.databaseId !== input.databaseId) {
    throw new Error('语义升级候选不存在。');
  }
  if (candidate.status !== 'rollout') {
    throw new Error('当前语义升级尚未进入灰度状态。');
  }

  const database = getDatabaseInstanceById(input.databaseId);
  if (!database) {
    throw new Error('数据源不存在。');
  }

  const rollouts = listDBHarnessSemanticUpgradeRollouts({
    upgradeId: candidate.id,
    databaseId: input.databaseId,
    status: 'active',
    limit: 200,
  });
  const now = new Date().toISOString();
  rollouts.forEach((rollout) => {
    upsertDBHarnessSemanticUpgradeRollout({
      ...rollout,
      status: 'completed',
      endedAt: now,
      updatedAt: now,
    });
  });

  const semanticModel = sanitizeDatabaseSemanticModel(database.semanticModel);
  let nextSemanticModel: DatabaseSemanticModel;
  if (semanticModel) {
    nextSemanticModel = semanticModel;
  } else {
    const schema = await getDatabaseSchema(database);
    const fallback = deriveSemanticSnapshot(schema, {});
    nextSemanticModel = {
      ...fallback,
      source: 'manual',
      updatedAt: now,
    };
  }
  candidate.diffs.forEach((diff) => {
    nextSemanticModel = applyDiffToSemanticModel(nextSemanticModel, diff);
  });
  nextSemanticModel = {
    ...nextSemanticModel,
    source: 'manual',
    updatedAt: now,
  };

  const updatedDatabase = updateDatabaseInstanceSemanticModel(database.id, nextSemanticModel);
  const upgraded = upsertDBHarnessSemanticUpgrade({
    ...candidate,
    status: 'finalized',
    finalizedAt: now,
  });
  return {
    upgrade: upgraded,
    databaseUpdated: Boolean(updatedDatabase),
  };
}

export function rejectSemanticUpgrade(input: RejectSemanticUpgradeInput): DBHarnessSemanticUpgradeCandidate {
  const candidate = getDBHarnessSemanticUpgradeById(input.upgradeId);
  if (!candidate || candidate.databaseId !== input.databaseId) {
    throw new Error('语义升级候选不存在。');
  }
  const rollouts = listDBHarnessSemanticUpgradeRollouts({
    upgradeId: candidate.id,
    databaseId: input.databaseId,
    status: 'active',
    limit: 200,
  });
  const now = new Date().toISOString();
  rollouts.forEach((rollout) => {
    upsertDBHarnessSemanticUpgradeRollout({
      ...rollout,
      status: 'stopped',
      endedAt: now,
      updatedAt: now,
    });
  });
  return upsertDBHarnessSemanticUpgrade({
    ...candidate,
    status: 'rejected',
    rejectedReason: input.reason?.trim() || 'manual-reject',
  });
}

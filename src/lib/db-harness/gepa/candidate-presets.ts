import type { DBHarnessGepaCandidate } from '../core/types';

export interface DBHarnessGepaPresetCandidate extends DBHarnessGepaCandidate {
  compressionLevel: 'standard' | 'compact' | 'minimal';
  nerTopK: number;
}

export const GEPA_PROMPT_CANDIDATE_PRESETS: DBHarnessGepaPresetCandidate[] = [
  {
    id: 'prompt-balanced',
    kind: 'prompt',
    source: 'policy',
    title: '平衡型 Prompt',
    description: '保留标准上下文层级，优先确保字段与规则完整。',
    promptPatch: '保留 Intent / Schema / Query 三层结构，偏向完整语义上下文。',
    confidence: 0.74,
    notes: ['适用于高准确率优先场景'],
    compressionLevel: 'standard',
    nerTopK: 24,
  },
  {
    id: 'prompt-compact',
    kind: 'prompt',
    source: 'policy',
    title: '紧凑型 Prompt',
    description: '减少冗余上下文，优先保留最近会话与高相关字段。',
    promptPatch: '强化最近问题与结果摘要，压缩低相关目录信息。',
    confidence: 0.76,
    notes: ['适用于长会话与高 token 压力场景'],
    compressionLevel: 'compact',
    nerTopK: 20,
  },
  {
    id: 'prompt-minimal',
    kind: 'prompt',
    source: 'policy',
    title: '最小化 Prompt',
    description: '更激进的上下文压缩，适合超长上下文回放。',
    promptPatch: '只保留最核心规则、规划提示和字段摘要。',
    confidence: 0.72,
    notes: ['适用于超长上下文兜底'],
    compressionLevel: 'minimal',
    nerTopK: 16,
  },
];

export const GEPA_POLICY_CANDIDATE_PRESETS: DBHarnessGepaPresetCandidate[] = [
  {
    id: 'policy-ner-wide',
    kind: 'policy',
    source: 'policy',
    title: 'NER 扩容',
    description: '把高相关字段候选上限提高到 24，提升召回。',
    policyPatch: { nerTopK: 24, schemaOverviewTables: 8 },
    confidence: 0.76,
    notes: ['更适合字段同义词较多的数据源'],
    compressionLevel: 'standard',
    nerTopK: 24,
  },
  {
    id: 'policy-ner-balanced',
    kind: 'policy',
    source: 'policy',
    title: 'NER 平衡',
    description: '保留 20 个候选，兼顾召回与提示长度。',
    policyPatch: { nerTopK: 20, schemaOverviewTables: 6 },
    confidence: 0.79,
    notes: ['适合作为默认候选'],
    compressionLevel: 'compact',
    nerTopK: 20,
  },
  {
    id: 'policy-ner-strict',
    kind: 'policy',
    source: 'policy',
    title: 'NER 收敛',
    description: '更小的候选集，减少 prompt 噪音。',
    policyPatch: { nerTopK: 16, schemaOverviewTables: 4 },
    confidence: 0.74,
    notes: ['适合特别长的问句'],
    compressionLevel: 'minimal',
    nerTopK: 16,
  },
];

export function getDefaultGepaPromptCandidateIds() {
  return GEPA_PROMPT_CANDIDATE_PRESETS.slice(0, 2).map((candidate) => candidate.id);
}

export function getDefaultGepaPolicyCandidateIds() {
  return GEPA_POLICY_CANDIDATE_PRESETS.map((candidate) => candidate.id);
}

export function buildGepaPresetCandidates(input: {
  promptCandidateCount?: number;
  policyCandidateCount?: number;
  selectedPromptCandidateIds?: string[];
  selectedPolicyCandidateIds?: string[];
}) {
  const promptSelected = Array.isArray(input.selectedPromptCandidateIds) && input.selectedPromptCandidateIds.length > 0
    ? GEPA_PROMPT_CANDIDATE_PRESETS.filter((candidate) => input.selectedPromptCandidateIds?.includes(candidate.id))
    : GEPA_PROMPT_CANDIDATE_PRESETS.slice(0, input.promptCandidateCount || 2);
  const policySelected = Array.isArray(input.selectedPolicyCandidateIds) && input.selectedPolicyCandidateIds.length > 0
    ? GEPA_POLICY_CANDIDATE_PRESETS.filter((candidate) => input.selectedPolicyCandidateIds?.includes(candidate.id))
    : GEPA_POLICY_CANDIDATE_PRESETS.slice(0, input.policyCandidateCount || 3);
  return [...promptSelected, ...policySelected];
}

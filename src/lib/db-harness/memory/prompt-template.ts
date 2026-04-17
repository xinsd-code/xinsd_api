import type {
  DBHarnessKnowledgeMemoryEntry,
  DBHarnessPromptTemplateRecord,
} from '../core/types';
import { compactText, dedupeStrings, scoreTextByKeywords } from '../core/utils';

const HIGH_CONFIDENCE_THRESHOLD = 0.78;

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.98, value));
}

function buildTemplateKey(input: {
  databaseId: string;
  questionHash?: string;
  summary?: string;
}): string {
  const questionSegment = (input.questionHash || '').slice(0, 16) || 'question';
  const summarySegment = compactText(input.summary || '', 24)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'template';
  return [input.databaseId, questionSegment, summarySegment].filter(Boolean).join(':');
}

function buildPromptPatchFromEntry(entry: DBHarnessKnowledgeMemoryEntry): string {
  const pieces = [
    entry.summary,
    entry.correctionRule ? `优先遵守纠正规则：${entry.correctionRule.correctMapping.label || entry.correctionRule.note || ''}` : '',
    entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
      ? [
          typeof entry.payload.planSummary === 'string' ? entry.payload.planSummary : '',
          typeof entry.payload.reply === 'string' ? entry.payload.reply : '',
        ].filter(Boolean).join(' ')
      : '',
  ].filter(Boolean);
  return compactText(pieces.join(' '), 420);
}

export function shouldPersistPromptTemplate(input: {
  feedbackType: 'positive' | 'corrective';
  confidence?: number;
  fromCache?: boolean;
}): boolean {
  if (input.feedbackType !== 'positive') return false;
  const confidence = clampConfidence(Number(input.confidence || 0));
  const threshold = input.fromCache ? HIGH_CONFIDENCE_THRESHOLD + 0.04 : HIGH_CONFIDENCE_THRESHOLD;
  return confidence >= threshold;
}

export function buildPromptTemplateRecord(input: {
  knowledgeEntry: DBHarnessKnowledgeMemoryEntry;
  databaseId: string;
  workspaceId?: string;
  confidence?: number;
  fromCache?: boolean;
  source?: 'feedback' | 'gepa';
}): Omit<DBHarnessPromptTemplateRecord, 'id' | 'createdAt' | 'updatedAt' | 'usageCount' | 'lastUsedAt'> {
  const payload = input.knowledgeEntry.payload || {};
  const questionHash = typeof payload['questionHash'] === 'string'
    ? payload['questionHash']
    : typeof payload['questionHash'] === 'number'
      ? String(payload['questionHash'])
      : undefined;
  const templateKey = buildTemplateKey({
    databaseId: input.databaseId,
    questionHash,
    summary: input.knowledgeEntry.summary,
  });
  const baseConfidence = clampConfidence(Number(input.confidence || payload['confidence'] || 0));

  return {
    templateKey,
    workspaceId: input.workspaceId,
    databaseId: input.databaseId,
    source: input.source || 'feedback',
    title: compactText(input.knowledgeEntry.summary, 48) || 'DB Harness 模板',
    description: input.knowledgeEntry.feedbackType === 'positive'
      ? '来自高置信度正反馈的可复用查询模板。'
      : '来自 GEPA 或反馈沉淀的模板。',
    promptPatch: buildPromptPatchFromEntry(input.knowledgeEntry),
    compressionLevel: typeof payload['compressionLevel'] === 'string'
      ? (payload['compressionLevel'] as DBHarnessPromptTemplateRecord['compressionLevel'])
      : undefined,
    nerCandidateLimit: typeof payload['nerCandidateLimit'] === 'number'
      ? Math.max(8, Math.min(Math.trunc(payload['nerCandidateLimit']), 32))
      : undefined,
    questionHash,
    queryFingerprint: typeof payload['queryFingerprint'] === 'string'
      ? payload['queryFingerprint']
      : undefined,
    confidence: baseConfidence,
    labels: dedupeStrings([
      input.knowledgeEntry.feedbackType || '',
      input.knowledgeEntry.source || '',
      typeof payload['question'] === 'string' ? payload['question'] : '',
    ], 40).slice(0, 6),
  };
}

export function buildPromptTemplateOverview(templates: DBHarnessPromptTemplateRecord[], limit = 6) {
  return templates.slice(0, limit).map((template) => ({
    key: template.templateKey,
    title: template.title,
    source: template.source,
    confidence: Number(template.confidence.toFixed(3)),
    compressionLevel: template.compressionLevel,
    nerCandidateLimit: template.nerCandidateLimit,
    description: template.description,
    promptPatch: template.promptPatch,
    labels: template.labels.slice(0, 4),
    usageCount: template.usageCount,
    updatedAt: template.updatedAt,
  }));
}

export function scorePromptTemplateForQuestion(template: DBHarnessPromptTemplateRecord, question: string): number {
  const keywords = new Set(question.toLowerCase().split(/\s+/).filter(Boolean));
  return scoreTextByKeywords(template.title, keywords)
    + scoreTextByKeywords(template.description, keywords)
    + scoreTextByKeywords(template.promptPatch, keywords)
    + template.confidence * 6
    + template.usageCount * 0.15;
}

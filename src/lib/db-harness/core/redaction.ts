import type { DBHarnessTurnArtifact } from './types';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d\s-]{6,}\d)(?!\d)/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function sanitizeSqlLiterals(text: string) {
  return text
    .replace(/'[^']*'/g, "'[redacted]'")
    .replace(/(:\s*)"(?!\$)([^"\\]|\\.){1,120}"/g, '$1"[redacted]"');
}

export function redactSensitiveText(value: string, mode: 'text' | 'query' = 'text') {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(PHONE_PATTERN, '[redacted-phone]')
    .replace(UUID_PATTERN, '[redacted-id]');
  return mode === 'query' ? sanitizeSqlLiterals(normalized) : normalized;
}

function sanitizeFilterValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizeFilterValue(item));
  }
  return value;
}

export function sanitizeArtifactForStorage(artifact: DBHarnessTurnArtifact | null | undefined) {
  if (!artifact) return null;
  return {
    sql: artifact.sql ? redactSensitiveText(artifact.sql, 'query') : undefined,
    summary: artifact.summary ? redactSensitiveText(artifact.summary) : undefined,
    previewSql: artifact.previewSql ? redactSensitiveText(artifact.previewSql, 'query') : undefined,
    planSummary: artifact.planSummary ? redactSensitiveText(artifact.planSummary) : undefined,
    queryPlan: artifact.queryPlan ? {
      intent: artifact.queryPlan.intent,
      strategy: artifact.queryPlan.strategy,
      targetTable: artifact.queryPlan.targetTable,
      summary: redactSensitiveText(artifact.queryPlan.summary),
      dimensions: artifact.queryPlan.dimensions.slice(0, 6),
      metrics: artifact.queryPlan.metrics.slice(0, 6),
      filters: artifact.queryPlan.filters.slice(0, 8).map((filter) => ({
        ...filter,
        value: sanitizeFilterValue(filter.value),
        source: redactSensitiveText(filter.source),
      })),
      orderBy: artifact.queryPlan.orderBy.slice(0, 4),
      limit: artifact.queryPlan.limit,
      notes: artifact.queryPlan.notes.slice(0, 8).map((note) => redactSensitiveText(note)),
      compiled: {
        text: redactSensitiveText(artifact.queryPlan.compiled.text, 'query'),
        values: [],
        previewSql: redactSensitiveText(artifact.queryPlan.compiled.previewSql, 'query'),
      },
    } : undefined,
    semanticOverview: artifact.semanticOverview ? {
      ...artifact.semanticOverview,
      focusEntities: artifact.semanticOverview.focusEntities.slice(0, 6),
    } : undefined,
    catalogOverview: artifact.catalogOverview ? {
      ...artifact.catalogOverview,
      focusEntities: artifact.catalogOverview.focusEntities.slice(0, 6),
    } : undefined,
    validation: artifact.validation,
  };
}

export function sanitizeKnowledgePayloadForStorage(payload: Record<string, unknown> | undefined) {
  const source = payload || {};
  return {
    ...source,
    question: typeof source.question === 'string' ? redactSensitiveText(source.question) : source.question,
    reply: typeof source.reply === 'string' ? redactSensitiveText(source.reply) : source.reply,
    note: typeof source.note === 'string' ? redactSensitiveText(source.note) : source.note,
    artifact: sanitizeArtifactForStorage(source.artifact as DBHarnessTurnArtifact | null | undefined),
  };
}

export function sanitizePromptTemplateInput(input: {
  title: string;
  description: string;
  promptPatch: string;
  labels?: string[];
}) {
  return {
    title: redactSensitiveText(input.title),
    description: redactSensitiveText(input.description),
    promptPatch: redactSensitiveText(input.promptPatch, 'query'),
    labels: (input.labels || []).map((item) => redactSensitiveText(item)).filter(Boolean),
  };
}

export function sanitizeMetricStorageInput(input: {
  question: string;
  sql: string;
  errorMessage?: string;
  labels?: string[];
}) {
  return {
    question: redactSensitiveText(input.question),
    sql: redactSensitiveText(input.sql, 'query'),
    errorMessage: input.errorMessage ? redactSensitiveText(input.errorMessage) : undefined,
    labels: (input.labels || []).map((item) => redactSensitiveText(item)).filter(Boolean),
  };
}

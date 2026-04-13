import { AIModelProfile, DatabaseInstance, DatabaseSchemaPayload } from '@/lib/types';

export type DBMultiAgentRole = 'intent' | 'schema' | 'query' | 'guardrail' | 'analysis';
export type DBMultiAgentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DBMultiAgentTraceStep {
  role: DBMultiAgentRole;
  title: string;
  status: DBMultiAgentStatus;
  detail: string;
  handoff?: {
    title: string;
    payload: string;
  };
}

export interface DBHarnessTurnArtifact {
  sql?: string;
  summary?: string;
  columns?: string[];
  previewRows?: Array<Record<string, unknown>>;
  previewSql?: string;
  planSummary?: string;
  queryPlan?: DBHarnessQueryPlan;
  catalogOverview?: DBHarnessCatalogOverview;
  semanticOverview?: DBHarnessSemanticOverview;
}

export interface DBHarnessTurnResponse {
  reply: string;
  trace: DBMultiAgentTraceStep[];
  artifacts?: DBHarnessTurnArtifact;
  followUps: string[];
  outcome: 'success' | 'empty' | 'error';
}

export interface DBHarnessChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status?: 'streaming' | 'done' | 'error';
  trace?: DBMultiAgentTraceStep[];
  artifacts?: DBHarnessTurnArtifact;
  followUps?: string[];
  meta?: {
    datasourceName?: string;
    modelLabel?: string;
    feedback?: DBHarnessFeedbackState;
  };
}

export interface DBHarnessSelectedModelInput {
  profileId: string;
  modelId: string;
}

export interface DBHarnessChatTurnRequest {
  workspaceId?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  selectedModel?: DBHarnessSelectedModelInput | null;
  databaseInstanceId?: string;
  currentSql?: string;
  currentResult?: {
    columns?: string[];
    rows?: Record<string, unknown>[];
    summary?: string;
  } | null;
}

export interface DBHarnessExecutionPayload {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  summary?: string;
  datasource: string;
  engine: 'mysql' | 'pgsql';
  previewSql: string;
}

export interface DatabaseFieldMetricView {
  metricName?: string;
  description?: string;
  metricType?: string;
  calcMode?: string;
  enableForNer?: boolean;
  aliases?: string[];
}

export interface DatabaseTableMetricView {
  description?: string;
  fields: Record<string, DatabaseFieldMetricView>;
}

export type DatabaseMetricViewMap = Record<string, DatabaseTableMetricView>;

export interface DBHarnessAiPayload {
  message: string;
  sql: string;
}

export interface DBHarnessNerCandidate {
  table: string;
  column: string;
  metricName?: string;
  description?: string;
  aliases: string[];
}

export interface DBHarnessMatchedMetric {
  term: string;
  table: string;
  column: string;
  metricName?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DBHarnessNerPayload {
  normalizedTerms: string[];
  matchedMetrics: DBHarnessMatchedMetric[];
  unmatchedTerms: string[];
  timeHints: string[];
  intent: string;
}

export interface DBHarnessKnowledgeMemoryEntry {
  key: string;
  summary: string;
  tags: string[];
  source?: 'schema' | 'feedback';
  feedbackType?: 'positive' | 'corrective';
  updatedAt?: string;
}

export interface DBHarnessFeedbackState {
  status: 'positive' | 'corrective';
  note?: string;
  learnedAt: string;
  summary: string;
}

export interface DBHarnessCatalogField {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  comment?: string;
  semanticRole: 'metric' | 'dimension' | 'time' | 'identifier' | 'attribute';
  referencesTable?: string;
  referencesColumn?: string;
  aliases: string[];
}

export interface DBHarnessCatalogEntity {
  name: string;
  description?: string;
  fieldCount: number;
  primaryKeys: string[];
  relatedEntities: string[];
  fields: DBHarnessCatalogField[];
}

export interface DBHarnessCatalogSnapshot {
  engine: DatabaseSchemaPayload['engine'];
  entityCount: number;
  relationCount: number;
  entities: DBHarnessCatalogEntity[];
}

export interface DBHarnessCatalogOverviewField {
  name: string;
  type: string;
  semanticRole: DBHarnessCatalogField['semanticRole'];
  comment?: string;
  aliases: string[];
  referencesTable?: string;
}

export interface DBHarnessCatalogOverviewEntity {
  table: string;
  description?: string;
  primaryKeys: string[];
  relatedEntities: string[];
  fields: DBHarnessCatalogOverviewField[];
}

export interface DBHarnessCatalogOverview {
  engine: DatabaseSchemaPayload['engine'];
  entityCount: number;
  relationCount: number;
  focusEntities: DBHarnessCatalogOverviewEntity[];
}

export interface DBHarnessSemanticField {
  table: string;
  column: string;
  metricName: string;
  description?: string;
  metricType?: string;
  calcMode?: string;
  enableForNer: boolean;
  aliases: string[];
  semanticRole: 'metric' | 'dimension' | 'time' | 'identifier' | 'attribute';
  derivedFrom: 'mapping' | 'schema' | 'manual';
}

export interface DBHarnessSemanticEntity {
  table: string;
  description?: string;
  metrics: string[];
  dimensions: string[];
  timeFields: string[];
  identifierFields: string[];
  nerEnabledFields: string[];
  fields: DBHarnessSemanticField[];
}

export interface DBHarnessSemanticSnapshot {
  entityCount: number;
  configuredFieldCount: number;
  inferredFieldCount: number;
  glossary: string[];
  entities: DBHarnessSemanticEntity[];
}

export interface DBHarnessSemanticOverviewEntity {
  table: string;
  description?: string;
  metrics: string[];
  dimensions: string[];
  timeFields: string[];
  nerEnabledFields: string[];
}

export interface DBHarnessSemanticOverview {
  entityCount: number;
  configuredFieldCount: number;
  inferredFieldCount: number;
  focusEntities: DBHarnessSemanticOverviewEntity[];
}

export interface DBHarnessPlanningHints {
  intent: string;
  candidateTables: string[];
  dimensions: string[];
  metrics: string[];
  filters: string[];
  timeRangeDays?: number | null;
  notes: string[];
}

export interface DBHarnessQueryPlanDimension {
  table: string;
  column: string;
  label: string;
}

export interface DBHarnessQueryPlanMetric {
  table: string;
  column: string;
  label: string;
  aggregate: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'value';
}

export interface DBHarnessQueryPlanFilter {
  table: string;
  column: string;
  label: string;
  operator: '=' | 'in' | '>=' | '<=' | 'like';
  value: string | number | boolean | Array<string | number>;
  source: string;
}

export interface DBHarnessQueryPlanOrderBy {
  column: string;
  label: string;
  direction: 'asc' | 'desc';
}

export interface DBHarnessCompiledQueryPlan {
  text: string;
  values: unknown[];
  previewSql: string;
}

export interface DBHarnessQueryPlan {
  intent: string;
  strategy: 'llm' | 'rule';
  targetTable?: string;
  summary: string;
  dimensions: DBHarnessQueryPlanDimension[];
  metrics: DBHarnessQueryPlanMetric[];
  filters: DBHarnessQueryPlanFilter[];
  orderBy: DBHarnessQueryPlanOrderBy[];
  limit: number;
  notes: string[];
  compiled: DBHarnessCompiledQueryPlan;
}

export interface DBHarnessSessionContext {
  turnId: string;
  startedAt: string;
  messages: DBHarnessChatTurnRequest['messages'];
  latestUserMessage: string;
  currentSql: string;
  currentResult: DBHarnessChatTurnRequest['currentResult'];
  recentQuestions: string[];
}

export interface DBHarnessWorkspaceContext {
  workspaceId?: string;
  workspaceRules?: string;
  databaseInstance: DatabaseInstance;
  profile: AIModelProfile;
  selectedModel: DBHarnessSelectedModelInput;
  endpoint: string;
  schema: DatabaseSchemaPayload;
  metricMappings: DatabaseMetricViewMap;
  catalog: DBHarnessCatalogSnapshot;
  semantic: DBHarnessSemanticSnapshot;
  knowledge: DBHarnessKnowledgeMemoryEntry[];
}

export interface DBHarnessIntentResult {
  intent: string;
  planningHints: DBHarnessPlanningHints;
  detail: string;
}

export interface DBHarnessSchemaResult {
  nerPayload: DBHarnessNerPayload;
  candidateBundle: {
    totalAvailable: number;
    candidateCount: number;
    truncated: boolean;
    candidates: DBHarnessNerCandidate[];
  };
  knowledgeEntries: DBHarnessKnowledgeMemoryEntry[];
  detail: string;
  usedFallback: boolean;
}

export interface DBHarnessQueryResult {
  aiPayload: DBHarnessAiPayload;
  plan: DBHarnessQueryPlan;
  detail: string;
  usedFallback: boolean;
}

export interface DBHarnessGuardrailResult {
  execution: DBHarnessExecutionPayload;
  detail: string;
}

export interface DBHarnessAnalysisResult {
  reply: string;
  summary: string;
  followUps: string[];
  detail: string;
}

export interface DBHarnessSessionRecord {
  id: string;
  workspaceId: string;
  title: string;
  messages: DBHarnessChatMessage[];
  selectedDatabaseId?: string;
  selectedModel?: DBHarnessSelectedModelInput | null;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessWorkspaceRecord {
  id: string;
  name: string;
  databaseId?: string;
  rules?: string;
  sessions: DBHarnessSessionRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessKnowledgeFeedbackRequest {
  workspaceId?: string;
  sessionId?: string;
  messageId: string;
  databaseInstanceId: string;
  question: string;
  reply: string;
  feedbackType: 'positive' | 'corrective';
  note?: string;
  artifacts?: DBHarnessTurnArtifact;
}

export interface DBHarnessKnowledgeFeedbackResponse {
  feedback: DBHarnessFeedbackState;
  knowledgeEntry: DBHarnessKnowledgeMemoryEntry;
}

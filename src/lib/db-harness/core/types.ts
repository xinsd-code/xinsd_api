import { AIModelProfile, DatabaseInstance, DatabaseInstanceType, DatabaseSchemaPayload } from '@/lib/types';

export type DBMultiAgentRole = 'intent' | 'schema' | 'query' | 'guardrail' | 'analysis';
export type DBMultiAgentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DBHarnessModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface DBHarnessAgentTelemetry {
  usage?: DBHarnessModelUsage;
  latencyMs?: number;
}

export type DBHarnessProgressStage =
  | 'session'
  | 'workspace'
  | DBMultiAgentRole
  | 'cache'
  | 'retry'
  | 'final';

export type DBHarnessProgressStatus = 'start' | 'running' | 'update' | 'complete' | 'error' | 'info';

export interface DBHarnessProgressEvent {
  id: string;
  turnId: string;
  stage: DBHarnessProgressStage;
  status: DBHarnessProgressStatus;
  message: string;
  detail?: string;
  trace?: DBMultiAgentTraceStep[];
  timestamp: string;
}

export interface DBMultiAgentTraceStep {
  role: DBMultiAgentRole;
  title: string;
  status: DBMultiAgentStatus;
  detail: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
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
  validation?: DBHarnessExecutionValidation;
  appliedUpgrades?: DBHarnessAppliedUpgradeSnapshot[];
  semanticOverlays?: DBHarnessSemanticOverlay[];
}

export interface DBHarnessTurnResponse {
  reply: string;
  trace: DBMultiAgentTraceStep[];
  artifacts?: DBHarnessTurnArtifact;
  followUps: string[];
  outcome: 'success' | 'empty' | 'error';
  confidence: number;
  fromCache?: boolean;
  progress?: DBHarnessProgressEvent[];
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
    confidence?: number;
    fromCache?: boolean;
    progress?: DBHarnessProgressEvent[];
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
  nerSelectedModel?: DBHarnessSelectedModelInput | null;
  databaseInstanceId?: string;
  currentSql?: string;
  currentResult?: {
    columns?: string[];
    rows?: Record<string, unknown>[];
    summary?: string;
  } | null;
  stream?: boolean;
}

export interface DBHarnessExecutionPayload {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  summary?: string;
  datasource: string;
  engine: DatabaseInstanceType;
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
  workspaceId?: string;
  databaseId?: string;
  sessionId?: string;
  messageId?: string;
  summary: string;
  tags: string[];
  source?: 'schema' | 'feedback';
  feedbackType?: 'positive' | 'corrective';
  updatedAt?: string;
  correctionRule?: DBHarnessFeedbackCorrectionRule;
  payload?: Record<string, unknown>;
}

export interface DBHarnessPromptTemplateRecord {
  id: string;
  templateKey: string;
  workspaceId?: string;
  databaseId: string;
  source: 'feedback' | 'gepa';
  title: string;
  description: string;
  promptPatch: string;
  compressionLevel?: 'standard' | 'compact' | 'minimal';
  nerCandidateLimit?: number;
  questionHash?: string;
  queryFingerprint?: string;
  confidence: number;
  labels: string[];
  usageCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessWorkspaceFreshnessSnapshot {
  resolvedAt: string;
  workspaceUpdatedAt?: string;
  databaseUpdatedAt?: string;
  semanticModelUpdatedAt?: string;
  sourceUpdatedAt?: string;
  cacheBuiltAt?: string;
  ageMs: number;
  freshnessScore: number;
  stale: boolean;
  notes: string[];
}

export interface DBHarnessKnowledgeQualitySnapshot {
  totalEntries: number;
  positiveEntries: number;
  correctiveEntries: number;
  correctionRuleEntries: number;
  freshEntries: number;
  lowSignalEntries: number;
  averageTagCount: number;
  qualityScore: number;
  notes: string[];
}

export interface DBHarnessFeedbackCorrectionMapping {
  table?: string;
  column?: string;
  label?: string;
}

export interface DBHarnessFeedbackCorrectionRule {
  wrongMapping: DBHarnessFeedbackCorrectionMapping;
  correctMapping: DBHarnessFeedbackCorrectionMapping;
  note?: string;
  source?: 'inferred' | 'explicit';
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
  runtimeConfig?: DBHarnessRuntimeConfig;
  freshness?: DBHarnessWorkspaceFreshnessSnapshot;
  knowledgeQuality?: DBHarnessKnowledgeQualitySnapshot;
  promptTemplates?: DBHarnessPromptTemplateRecord[];
  activeUpgrades?: DBHarnessAppliedUpgradeSnapshot[];
  semanticOverlays?: DBHarnessSemanticOverlay[];
  databaseInstance: DatabaseInstance;
  profile: AIModelProfile;
  selectedModel: DBHarnessSelectedModelInput;
  endpoint: string;
  nerProfile?: AIModelProfile;
  nerSelectedModel?: DBHarnessSelectedModelInput;
  nerEndpoint?: string;
  schema: DatabaseSchemaPayload;
  metricMappings: DatabaseMetricViewMap;
  catalog: DBHarnessCatalogSnapshot;
  semantic: DBHarnessSemanticSnapshot;
  knowledge: DBHarnessKnowledgeMemoryEntry[];
  semanticEmbeddingIndex?: DBHarnessSemanticEmbeddingIndex | null;
}

export interface DBHarnessIntentResult {
  intent: string;
  planningHints: DBHarnessPlanningHints;
  detail: string;
  telemetry?: DBHarnessAgentTelemetry;
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
  telemetry?: DBHarnessAgentTelemetry;
}

export interface DBHarnessQueryResult {
  aiPayload: DBHarnessAiPayload;
  plan: DBHarnessQueryPlan;
  detail: string;
  usedFallback: boolean;
  telemetry?: DBHarnessAgentTelemetry;
}

export interface DBHarnessGuardrailResult {
  detail: string;
  execution?: DBHarnessExecutionPayload;
}

export interface DBHarnessAnalysisResult {
  reply: string;
  summary: string;
  followUps: string[];
  detail: string;
}

export interface DBHarnessExecutionValidationIssue {
  code: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface DBHarnessExecutionValidation {
  status: 'pass' | 'review' | 'fail';
  score: number;
  summary: string;
  issues: DBHarnessExecutionValidationIssue[];
}

export interface DBHarnessQueryMetricRecord {
  id: string;
  turnId: string;
  workspaceId?: string;
  databaseId: string;
  engine: DatabaseInstanceType;
  question: string;
  questionHash: string;
  sql: string;
  queryFingerprint: string;
  outcome: DBHarnessTurnResponse['outcome'];
  confidence: number;
  fromCache: boolean;
  rowCount: number;
  agentTelemetry: Partial<Record<DBMultiAgentRole, DBHarnessAgentTelemetry>>;
  appliedUpgradeIds?: string[];
  semanticOverlayIds?: string[];
  validationScore?: number;
  feedbackLabel?: 'positive' | 'corrective' | 'none';
  retryUsed?: boolean;
  labels: string[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessSemanticEmbeddingMatch {
  kind: 'field' | 'knowledge';
  id: string;
  label: string;
  table?: string;
  column?: string;
  summary: string;
  score: number;
  tags: string[];
}

export interface DBHarnessSemanticEmbeddingIndex {
  profile: AIModelProfile;
  sourceProfileId: string;
  sourceModelId: string;
  endpoint: string;
  builtAt: string;
  items: Array<{
    kind: DBHarnessSemanticEmbeddingMatch['kind'];
    id: string;
    label: string;
    table?: string;
    column?: string;
    summary: string;
    tags: string[];
    embedding: number[];
  }>;
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
  runtimeConfig?: DBHarnessRuntimeConfig;
  sessions: DBHarnessSessionRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessRuntimeConfig {
  preferredCompressionLevel?: 'standard' | 'compact' | 'minimal';
  nerCandidateLimit?: number;
  semanticEmbeddingLimit?: number;
  schemaOverviewTables?: number;
  promptStrategy?: string;
  source?: 'manual' | 'gepa';
  appliedRunId?: string;
  appliedCandidateIds?: string[];
  updatedAt?: string;
}

export type DBHarnessUpgradeTarget = DBMultiAgentRole | 'orchestrator';
export type DBHarnessUpgradeArtifactType =
  | 'prompt_patch'
  | 'query_template'
  | 'retrieval_rule'
  | 'correction_rule'
  | 'policy_patch'
  | 'analysis_template';
export type DBHarnessUpgradeStatus = 'draft' | 'pending_review' | 'approved' | 'applied' | 'rejected';

export interface DBHarnessUpgradeArtifact {
  type: DBHarnessUpgradeArtifactType;
  summary: string;
  promptPatch?: string;
  templateKey?: string;
  payload?: Record<string, unknown>;
}

export interface DBHarnessUpgradeEvaluation {
  score: number;
  baselineScore: number;
  sqlSuccessRate: number;
  emptyRate: number;
  correctiveRate: number;
  avgLatencyMs: number;
  avgValidationScore: number;
  notes: string[];
}

export interface DBHarnessUpgradeCandidate {
  id: string;
  workspaceId: string;
  target: DBHarnessUpgradeTarget;
  sourceTurnId: string;
  artifactType: DBHarnessUpgradeArtifactType;
  status: DBHarnessUpgradeStatus;
  confidence: number;
  title: string;
  description: string;
  artifact: DBHarnessUpgradeArtifact;
  evaluation?: DBHarnessUpgradeEvaluation;
  rejectedReason?: string;
  appliedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessAppliedUpgradeSnapshot {
  upgradeId: string;
  workspaceId: string;
  target: DBHarnessUpgradeTarget;
  artifactType: DBHarnessUpgradeArtifactType;
  title: string;
  confidence: number;
  appliedAt: string;
}

export type DBHarnessSemanticUpgradeChangeType = 'alias' | 'description' | 'ner_flag';
export type DBHarnessSemanticUpgradeStatus = 'draft' | 'pending_review' | 'rollout' | 'finalized' | 'rejected';

export interface DBHarnessSemanticFieldRef {
  table: string;
  column: string;
}

export interface DBHarnessSemanticUpgradeDiff {
  changeType: DBHarnessSemanticUpgradeChangeType;
  fieldRef: DBHarnessSemanticFieldRef;
  before: string | boolean;
  after: string | boolean;
}

export interface DBHarnessSemanticUpgradeEvaluation {
  score: number;
  baselineScore: number;
  schemaHitRate: number;
  sqlSuccessRate: number;
  emptyRate: number;
  correctiveRate: number;
  errorMappingRate: number;
  avgLatencyMs: number;
  avgValidationScore: number;
  notes: string[];
}

export interface DBHarnessSemanticUpgradeEvidence {
  kind: 'corrective_feedback' | 'cross_workspace_synonym';
  workspaceCount: number;
  hitCount: number;
  sampleNotes: string[];
}

export interface DBHarnessSemanticUpgradeCandidate {
  id: string;
  databaseId: string;
  sourceWorkspaceId: string;
  status: DBHarnessSemanticUpgradeStatus;
  confidence: number;
  title: string;
  description: string;
  diffs: DBHarnessSemanticUpgradeDiff[];
  evidence?: DBHarnessSemanticUpgradeEvidence[];
  evaluation?: DBHarnessSemanticUpgradeEvaluation;
  rejectedReason?: string;
  finalizedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessSemanticUpgradeRollout {
  id: string;
  upgradeId: string;
  databaseId: string;
  workspaceId: string;
  status: 'active' | 'stopped' | 'completed';
  startedAt: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessSemanticUpgradeImpactSummary {
  databaseWorkspaceCount: number;
  impactedWorkspaceIds: string[];
  rolloutWorkspaceIds: string[];
  impactedEntities: string[];
  impactedFieldRefs: string[];
  activeRolloutWorkspaceCount: number;
  completedRolloutWorkspaceCount: number;
  stoppedRolloutWorkspaceCount: number;
}

export interface DBHarnessSemanticUpgradeGovernance {
  upgradeId: string;
  impact: DBHarnessSemanticUpgradeImpactSummary;
  rolloutTimeline: Array<{
    workspaceId: string;
    status: DBHarnessSemanticUpgradeRollout['status'];
    startedAt: string;
    endedAt?: string;
  }>;
}

export interface DBHarnessSemanticOverlay {
  upgradeId: string;
  databaseId: string;
  workspaceId: string;
  changeType: DBHarnessSemanticUpgradeChangeType;
  table: string;
  column: string;
  before: string | boolean;
  after: string | boolean;
  status: 'active' | 'stopped' | 'completed';
  startedAt: string;
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
  confidence?: number;
  fromCache?: boolean;
  artifacts?: DBHarnessTurnArtifact;
}

export interface DBHarnessKnowledgeFeedbackResponse {
  feedback: DBHarnessFeedbackState;
  knowledgeEntry: DBHarnessKnowledgeMemoryEntry;
}

export type DBHarnessGepaCandidateKind = 'prompt' | 'policy';
export type DBHarnessGepaRunStatus = 'draft' | 'running' | 'reviewed' | 'applied' | 'failed';

export interface DBHarnessGepaScoreCard {
  sqlSuccessRate: number;
  emptyRate: number;
  latencyAvgMs: number;
  latencyP95Ms: number;
  tokenCost: number;
  balancedScore: number;
  baselineBalancedScore?: number;
  notes: string[];
}

export interface DBHarnessGepaCandidate {
  id: string;
  kind: DBHarnessGepaCandidateKind;
  source?: 'policy' | 'template' | 'pattern';
  title: string;
  description: string;
  compressionLevel?: 'standard' | 'compact' | 'minimal';
  nerTopK?: number;
  promptPatch?: string;
  policyPatch?: Record<string, unknown>;
  confidence?: number;
  notes: string[];
}

export interface DBHarnessGepaSampleResult {
  sampleId: string;
  question: string;
  baseline: {
    status: 'success' | 'empty' | 'error';
    latencyMs: number;
    tokenCost: number;
    score: number;
    detail: string;
  };
  candidate: {
    status: 'success' | 'empty' | 'error';
    latencyMs: number;
    tokenCost: number;
    score: number;
    detail: string;
  };
  delta: {
    score: number;
    latencyMs: number;
    tokenCost: number;
  };
}

export interface DBHarnessGepaRun {
  id: string;
  workspaceId?: string;
  databaseId: string;
  sampleLimit: number;
  datasetVersion: string;
  status: DBHarnessGepaRunStatus;
  candidateSet: DBHarnessGepaCandidate[];
  samples: DBHarnessGepaSampleResult[];
  scoreCard: DBHarnessGepaScoreCard;
  report: Record<string, unknown>;
  approvedAt?: string;
  approvedBy?: string;
  appliedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DBHarnessRuntimeConfigDiffEntry {
  key: keyof Pick<DBHarnessRuntimeConfig, 'preferredCompressionLevel' | 'nerCandidateLimit' | 'schemaOverviewTables' | 'promptStrategy'>;
  label: string;
  before: string;
  after: string;
}

export interface DBHarnessGepaCreateRequest {
  workspaceId: string;
  databaseId: string;
  sampleLimit?: number;
  promptCandidateCount?: number;
  policyCandidateCount?: number;
  selectedPromptCandidateIds?: string[];
  selectedPolicyCandidateIds?: string[];
}

export interface DBHarnessGepaApplyRequest {
  approvedBy?: string;
}

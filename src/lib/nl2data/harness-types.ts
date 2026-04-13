export type HarnessTraceRole = 'intent' | 'schema' | 'query' | 'guardrail' | 'analysis';
export type HarnessTraceStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface HarnessTraceStep {
  role: HarnessTraceRole;
  title: string;
  status: HarnessTraceStatus;
  detail: string;
}

export interface HarnessTurnArtifact {
  sql?: string;
  summary?: string;
  columns?: string[];
  previewRows?: Array<Record<string, unknown>>;
  previewSql?: string;
}

export interface HarnessTurnResponse {
  reply: string;
  trace: HarnessTraceStep[];
  artifacts?: HarnessTurnArtifact;
  followUps: string[];
  outcome: 'success' | 'empty' | 'error';
}

export interface HarnessChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status?: 'streaming' | 'done' | 'error';
  trace?: HarnessTraceStep[];
  artifacts?: HarnessTurnArtifact;
  meta?: {
    datasourceName?: string;
    modelLabel?: string;
  };
}

const TRACE_BLUEPRINT: Array<Pick<HarnessTraceStep, 'role' | 'title'>> = [
  { role: 'intent', title: 'Intent Agent' },
  { role: 'schema', title: 'Schema Agent' },
  { role: 'query', title: 'Query Agent' },
  { role: 'guardrail', title: 'Guardrail Agent' },
  { role: 'analysis', title: 'Analysis Agent' },
];

export function createPendingTrace(): HarnessTraceStep[] {
  return TRACE_BLUEPRINT.map((step) => ({
    ...step,
    status: 'pending',
    detail: '等待本轮调度开始',
  }));
}

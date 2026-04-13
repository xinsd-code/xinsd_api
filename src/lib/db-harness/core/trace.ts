import { DBHarnessTurnResponse, DBMultiAgentRole, DBMultiAgentTraceStep } from './types';

const TRACE_BLUEPRINT: Array<Pick<DBMultiAgentTraceStep, 'role' | 'title'>> = [
  { role: 'intent', title: 'Intent Agent' },
  { role: 'schema', title: 'Schema Agent' },
  { role: 'query', title: 'Query Agent' },
  { role: 'guardrail', title: 'Guardrail Agent' },
  { role: 'analysis', title: 'Analysis Agent' },
];

export function createPendingTrace(): DBMultiAgentTraceStep[] {
  return TRACE_BLUEPRINT.map((step) => ({
    ...step,
    status: 'pending',
    detail: '等待本轮调度开始',
  }));
}

export function cloneTrace(trace: DBMultiAgentTraceStep[]): DBMultiAgentTraceStep[] {
  return trace.map((step) => ({ ...step }));
}

export function updateTrace(
  trace: DBMultiAgentTraceStep[],
  role: DBMultiAgentRole,
  status: DBMultiAgentTraceStep['status'],
  detail: string,
  handoff?: DBMultiAgentTraceStep['handoff']
) {
  const target = trace.find((step) => step.role === role);
  if (!target) return;
  target.status = status;
  target.detail = detail;
  target.handoff = handoff;
}

function failTraceFrom(trace: DBMultiAgentTraceStep[], role: DBMultiAgentRole, detail: string) {
  let afterFailure = false;
  trace.forEach((step) => {
    if (step.role === role) {
      step.status = 'failed';
      step.detail = detail;
      afterFailure = true;
      return;
    }
    if (afterFailure && step.status === 'pending') {
      step.detail = '由于上一步失败，本步骤未开始。';
    }
  });
}

export function buildFailureResponse(
  trace: DBMultiAgentTraceStep[],
  role: DBMultiAgentRole,
  detail: string,
  sql?: string
): DBHarnessTurnResponse {
  failTraceFrom(trace, role, detail);
  return {
    outcome: 'error',
    reply: detail,
    trace: cloneTrace(trace),
    artifacts: sql
      ? {
          sql,
          summary: '当前回合已中断，没有生成可用的数据结果。',
        }
      : undefined,
    followUps: [],
  };
}

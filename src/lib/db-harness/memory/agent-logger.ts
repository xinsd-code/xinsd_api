import { compactJson, compactText } from '../core/utils';

function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return compactText(payload, 4000);
  }
  return compactJson(payload, 6000);
}

export class DBHarnessAgentLogger {
  constructor(private readonly turnId: string) {}

  log(scope: string, event: string, payload?: unknown) {
    if (payload === undefined) {
      console.info(`[DB-Multi-Agent][turn:${this.turnId}][${scope}] ${event}`);
      return;
    }

    console.info(
      `[DB-Multi-Agent][turn:${this.turnId}][${scope}] ${event}\n${formatPayload(payload)}`
    );
  }
}
